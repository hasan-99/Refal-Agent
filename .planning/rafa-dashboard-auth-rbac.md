# RAFA Dashboard Authentication and Access Control

## Goal

Replace the shared dashboard password with Supabase Auth accounts, secure refreshable sessions, password recovery, and enforceable admin/member access across dashboard APIs and Supabase data. Keep secrets server-side and make the first-admin setup explicit and auditable.

## Roles

| Capability | Admin | User |
| --- | --- | --- |
| Overview, lead list/detail, bookings, approved knowledge, reports | Read | Read |
| RAFA chat and personal chat history | Own sessions | Own sessions |
| Create/update users and assign roles | Yes | No |
| Create/import/fetch/approve/disable knowledge | Yes | No |
| Edit lead/contact data, booking policy, model settings, shared memory | Yes | No |
| Export reports | Yes | No |

Rules: new users are invited by an admin and default to `user`; no public registration; only server/admin operations can change roles; user metadata is never an authorization source; inactive/missing roles fail closed. Existing unowned RAFA sessions remain admin-visible only; new dashboard chats are scoped to their creator.

## Milestones and Waves

### M1 - Authorization Foundation
- [x] W1: Inspect existing dashboard, Supabase data access, and auth surface.
- [x] W2: Define admin/user policy matrix and fail-closed role model.
- [x] W3: Add role/session ownership schema and RLS policies with rollback notes.

### M2 - Authentication and Recovery
- [x] W1: Replace shared password login with Supabase email/password sign-in; secure cookie lifecycle and server-verified session.
- [x] W2: Add password reset request, recovery callback, password update, logout, and inactive-session handling.
- [x] W3: Redesign responsive login/recovery screens and accessible validation/loading/error states.

### M3 - Admin and Team Operations
- [x] W1: Add protected admin Edge Function for invite/list/role change/disable operations.
- [x] W2: Add team management dashboard view; bootstrap first admin safely and document setup.
- [x] W3: Apply role/status changes immediately at Express and RLS authorization boundaries; the access-token hook derives current claims.

### M4 - Permissions Across RAFA
- [x] W1: Enforce route-level read/write permissions in Express; UI hiding is not authorization.
- [x] W2: Scope dashboard chat sessions to user identity; keep WhatsApp conversations/knowledge shared as defined above.
- [x] W3: Add Postgres RLS role checks for user-owned records and admin-only operations; add locally testable ownership/access policy checks.

### M5 - Verification and Rollout
- [ ] W1: Test login, refresh, logout, recovery, invite, role change, forbidden access, ownership isolation, and migration/RLS behavior. Local helper/ownership tests pass; real Auth and role/ownership integration tests await project Auth configuration and accounts.
- [x] W2: Run dashboard and repository test/build checks; scan config/build artifacts for secrets. Dashboard tests/build and repository tests pass; local HTTP checks enforce unauthenticated and CSRF denial.
- [ ] W3: Configure Supabase Auth URLs/SMTP and the custom access-token hook; bootstrap a verified owner admin and verify real admin/user flows. The schema and `rafa-admin-api` are deployed.

## Dependencies and External Gates

- Supabase MCP is connected. The `RAFAist` project is active and healthy; the `rafa_dashboard_users`/RLS schema and `rafa-admin-api` v1 are deployed, and the missing dashboard-user creator index is also deployed.
- Supabase CLI Management authorization is still unavailable (`Unauthorized`), and CLI database linking reports IPv6 unavailable. Use authenticated Supabase MCP for supported migrations/functions; project-level Auth Hook, SMTP, URL, and Edge Function secret configuration are not exposed by the available MCP actions.
- Password reset requires the Supabase project's site URL, recovery redirect allow-list, and configured email sender/SMTP. Configure in Supabase before production use.
- A first admin must be provisioned through a one-time protected bootstrap or operator SQL action; no shared default password or public signup is allowed.
- Provisioning sequence: (1) set `RAFA_INITIAL_ADMIN_EMAIL` to the verified owner email in `rafa-admin-api` secrets and configure the exact dashboard invite/recovery URL plus an email sender; (2) create/invite that owner through Supabase Auth, have them verify email and initialize the one-time admin role in the dashboard; (3) invite the member through Team, where they choose their own password. Never store or reuse a shared initial password. Auth users/dashboard memberships are currently both zero, and the connected Supabase tools do not expose Auth user creation or Edge Function secret management.
- The owner supplied a shared initial password in chat. It was not used to create accounts; treat it as exposed and do not reuse it. Set new, distinct passwords privately via the Supabase invitation/reset flow.
- Set `DASHBOARD_COOKIE_SECURE=true` behind HTTPS in production; localhost development remains HTTP-compatible.

## Implementation Notes

- Access token authority is Supabase Auth. Refresh tokens stay in server-managed cookies; APIs use server-verified users, never decoded client claims alone.
- Roles are authoritative in `public.rafa_dashboard_users`; the custom Auth hook adds top-level `dashboard_role` and `dashboard_active` claims. Express and RLS also consult the protected live role table so changed access does not wait for token expiry.
- Service-role key remains server/Edge-Function-only. RLS is enabled on every newly exposed table.
- Project-level Auth Hook setup, first-admin bootstrap, password-recovery email delivery, and real account/RLS integration tests remain pending until project Auth settings and the owner's verified admin email are configured.

## Rollback Notes

Disable the custom access-token hook in Supabase Auth settings first. To roll back the migration after disabling dashboard Auth: drop the three RAFA session/message/memory RLS policies created here; drop `rafa_dashboard_access_token_hook`, `rafa_bootstrap_dashboard_admin`, `rafa_update_dashboard_user`, and the two `rafa_private.dashboard_user_*` helpers; revoke authenticated grants; drop the owner index and `owner_user_id` column; then drop `rafa_dashboard_users`. Preserve `rafa_agent_sessions` and conversation data. Existing unowned sessions are not deleted by rollback.
