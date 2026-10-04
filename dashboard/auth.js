import { createServerClient } from "@supabase/ssr";

export const AUTH_COOKIE_NAME = "rafa-dashboard-auth";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export function createRequestAuthClient(req, res) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    const error = new Error("Supabase Auth is not configured. Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY.");
    error.statusCode = 503;
    throw error;
  }

  const secure = req.secure || String(process.env.DASHBOARD_COOKIE_SECURE || "false").toLowerCase() === "true";
  return createServerClient(url, key, {
    cookieOptions: {
      name: AUTH_COOKIE_NAME,
      path: "/",
      sameSite: "lax",
      secure,
      httpOnly: true,
      maxAge: SESSION_MAX_AGE_SECONDS
    },
    cookieEncoding: "base64url",
    auth: { autoRefreshToken: false, persistSession: true, detectSessionInUrl: false, flowType: "pkce" },
    cookies: {
      getAll: () => parseCookieHeader(req.headers.cookie),
      setAll: (cookies, responseHeaders) => {
        applyAuthResponseHeaders(res, responseHeaders);
        for (const item of cookies) {
          res.append("Set-Cookie", serializeCookie(item.name, item.value, {
            ...item.options,
            path: "/",
            sameSite: "lax",
            httpOnly: true,
            secure
          }));
        }
      }
    }
  });
}

export function parseCookieHeader(header = "") {
  return String(header).split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    if (separator < 1) return [];
    const name = part.slice(0, separator).trim();
    const rawValue = part.slice(separator + 1).trim();
    try { return [{ name, value: decodeURIComponent(rawValue) }]; }
    catch { return [{ name, value: rawValue }]; }
  });
}

export function serializeCookie(name, value, options = {}) {
  const parts = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  parts.push(`Path=${options.path || "/"}`);
  if (options.expires instanceof Date) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  const sameSite = options.sameSite;
  if (sameSite) parts.push(`SameSite=${sameSite === true ? "Strict" : `${sameSite[0].toUpperCase()}${sameSite.slice(1)}`}`);
  if (options.domain) parts.push(`Domain=${options.domain}`);
  return parts.join("; ");
}

export function clearAuthCookies(req, res, secure = false) {
  for (const { name } of parseCookieHeader(req.headers.cookie)) {
    if (name === AUTH_COOKIE_NAME || name.startsWith(`${AUTH_COOKIE_NAME}.`)) {
      res.append("Set-Cookie", serializeCookie(name, "", {
        path: "/", sameSite: "lax", httpOnly: true, secure, maxAge: 0,
        expires: new Date(0)
      }));
    }
  }
}

export function applyAuthResponseHeaders(res, headers = {}) {
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
}

export function isSameOriginRequest(origin, host, fetchSite, protocol = "") {
  if (fetchSite === "cross-site" || !host) return false;
  if (!origin) return fetchSite === "same-origin";
  try {
    const parsed = new URL(origin);
    return parsed.host.toLowerCase() === String(host).toLowerCase()
      && (parsed.protocol === "https:" || parsed.protocol === "http:")
      && (!protocol || parsed.protocol === `${String(protocol).replace(/:$/, "")}:`);
  } catch { return false; }
}

export function validPassword(password) {
  return typeof password === "string"
    && password.length >= 12
    && /[a-z]/.test(password)
    && /[A-Z]/.test(password)
    && /\d/.test(password);
}

export function roleAllows(role, requiredRole) {
  if (role !== "admin" && role !== "user") return false;
  return requiredRole === "user" || role === "admin";
}

export function canAccessDashboardSession(session, user) {
  if (!session || !user?.id || !roleAllows(user.role, "user")) return false;
  return session.owner_user_id === user.id || (user.role === "admin" && session.owner_user_id === null);
}
