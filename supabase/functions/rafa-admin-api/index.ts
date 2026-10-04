import { createClient, type User } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

const url = Deno.env.get("SUPABASE_URL") || "";
const publishableKey = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY") || "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SECRET_KEY") || "";
const service = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  try {
    const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
    if (!token || !publishableKey || !serviceKey) return json({ error: "Unauthorized." }, 401);
    const callerClient = createClient(url, publishableKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } }
    });
    const { data: callerData, error: callerError } = await callerClient.auth.getUser(token);
    if (callerError || !callerData.user) return json({ error: "Unauthorized." }, 401);
    const caller = callerData.user;
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");

    if (action === "bootstrap-admin") return await bootstrapAdmin(caller);

    const { data: actor, error: actorError } = await service
      .from("rafa_dashboard_users")
      .select("user_id,role,is_active")
      .eq("user_id", caller.id)
      .maybeSingle();
    if (actorError) throw actorError;
    if (!actor?.is_active || actor.role !== "admin") return json({ error: "Administrator access is required." }, 403);

    if (action === "list-users") return await listUsers();
    if (action === "invite-user") return await inviteUser(caller, body.email);
    if (action === "update-user") return await updateUser(caller, body);
    return json({ error: "Unknown account operation." }, 400);
  } catch (error) {
    const requestId = crypto.randomUUID();
    console.error("rafa-admin-api request failed", { requestId, error });
    const message = error instanceof HttpError ? error.message : "Account operation failed.";
    const status = error instanceof HttpError ? error.status : 500;
    return json({ error: message, requestId }, status);
  }
});

async function bootstrapAdmin(caller: User) {
  const configuredEmail = (Deno.env.get("RAFA_INITIAL_ADMIN_EMAIL") || "").trim().toLowerCase();
  if (!configuredEmail) throw new HttpError("Initial admin email is not configured.", 503);
  if (!caller.email_confirmed_at || caller.email?.toLowerCase() !== configuredEmail) {
    throw new HttpError("This verified account is not allowed to initialize the workspace.", 403);
  }
  const { error } = await service.rpc("rafa_bootstrap_dashboard_admin", { p_user_id: caller.id });
  if (error) {
    if (error.code === "23505") throw new HttpError("An active administrator already exists.", 409);
    throw error;
  }
  return json({ ok: true, role: "admin" });
}

async function listUsers() {
  const { data: memberships, error } = await service
    .from("rafa_dashboard_users")
    .select("user_id,role,is_active,created_at,updated_at")
    .order("created_at", { ascending: true });
  if (error) throw error;
  const users = await Promise.all((memberships || []).map(async (membership) => {
    const { data, error: userError } = await service.auth.admin.getUserById(membership.user_id);
    if (userError || !data.user) return { ...membership, email: "Unavailable", confirmed: false };
    return {
      ...membership,
      email: data.user.email || "",
      confirmed: Boolean(data.user.email_confirmed_at),
      lastSignInAt: data.user.last_sign_in_at || null
    };
  }));
  return json({ users });
}

async function inviteUser(caller: User, input: unknown) {
  const email = typeof input === "string" ? input.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
    throw new HttpError("Enter a valid email address.", 400);
  }
  const redirect = Deno.env.get("DASHBOARD_AUTH_SITE_URL");
  if (!redirect) throw new HttpError("DASHBOARD_AUTH_SITE_URL is not configured for invite links.", 503);
  const { data, error } = await service.auth.admin.inviteUserByEmail(email, { redirectTo: new URL("/auth/callback?next=reset", redirect).href });
  if (error || !data.user) throw new HttpError("Could not send the invitation. Check the email configuration and try again.", 502);
  const { error: roleError } = await service.from("rafa_dashboard_users").insert({
    user_id: data.user.id,
    role: "user",
    is_active: true,
    created_by: caller.id
  });
  if (roleError) {
    await service.auth.admin.deleteUser(data.user.id);
    if (roleError.code === "23505") throw new HttpError("This account already has a dashboard invitation.", 409);
    throw roleError;
  }
  return json({ ok: true, user: { id: data.user.id, email, role: "user", is_active: true } }, 201);
}

async function updateUser(caller: User, body: Record<string, unknown>) {
  const userId = typeof body.userId === "string" ? body.userId : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
    throw new HttpError("Invalid account id.", 400);
  }
  const { data: target, error } = await service.from("rafa_dashboard_users")
    .select("user_id,role,is_active").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  if (!target) throw new HttpError("Dashboard account not found.", 404);
  if (userId === caller.id && body.isActive === false) throw new HttpError("You cannot disable your own account.", 400);
  const role = body.role === undefined ? target.role : body.role;
  const isActive = body.isActive === undefined ? target.is_active : body.isActive;
  if (!["admin", "user"].includes(String(role)) || typeof isActive !== "boolean") {
    throw new HttpError("Invalid role or account state.", 400);
  }
  const { error: updateError } = await service.rpc("rafa_update_dashboard_user", {
    p_user_id: userId,
    p_role: role,
    p_is_active: isActive,
    p_actor_id: caller.id
  });
  if (updateError) {
    const status = updateError.code === "P0002" ? 404 : updateError.code === "42501" ? 403 : 409;
    const message = status === 404 ? "Dashboard account not found." : status === 403 ? "This account change is not allowed." : "Could not update the dashboard account. Refresh and try again.";
    throw new HttpError(message, status);
  }
  return json({ ok: true, user: { user_id: userId, role, is_active: isActive } });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

class HttpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
