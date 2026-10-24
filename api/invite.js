// POST /api/invite — invite a user by e-mail into the current company.
//   headers: Authorization: Bearer <the inviter's Supabase access token>, x-org-id
//   body:    { email, role_key, full_name? }
// The inviter must be the owner or hold users.manage in that company. A new
// address receives Supabase's invitation e-mail; an existing account is
// simply added. Membership is written through add_member() in the service
// context, so the same rules apply as in the app.
import { serviceClient, send, readJson, HttpError } from "./_lib.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") throw new HttpError(405, "method not allowed");
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const orgId = String(req.headers["x-org-id"] || "");
    if (!token || !/^[0-9a-f-]{36}$/i.test(orgId)) throw new HttpError(401, "sign in required");
    const { email, role_key, full_name } = await readJson(req);
    const addr = String(email || "").trim().toLowerCase();
    if (!EMAIL.test(addr)) throw new HttpError(400, "a valid e-mail is required");
    if (!role_key) throw new HttpError(400, "role is required");

    const admin = serviceClient();
    const { data: who, error: authErr } = await admin.auth.getUser(token);
    if (authErr || !who?.user) throw new HttpError(401, "sign in required");
    const { data: m } = await admin.from("org_members").select("is_owner, role_key, active")
      .eq("org_id", orgId).eq("user_id", who.user.id).maybeSingle();
    let allowed = !!(m?.active && m.is_owner);
    if (m?.active && !allowed) {
      const { data: rp } = await admin.from("role_permissions").select("perm_key")
        .eq("org_id", orgId).eq("role_key", m.role_key).eq("perm_key", "users.manage").maybeSingle();
      allowed = !!rp;
    }
    if (!allowed) throw new HttpError(403, "permission denied: users.manage");
    const { data: role } = await admin.from("roles").select("key").eq("org_id", orgId).eq("key", role_key).maybeSingle();
    if (!role) throw new HttpError(400, "unknown role");

    const origin = req.headers.origin || `https://${req.headers.host}`;
    let invited = false;
    const { error: invErr } = await admin.auth.admin.inviteUserByEmail(addr, { data: { full_name: full_name || null }, redirectTo: `${origin}/` });
    if (invErr) {
      // an existing account is fine — it is just added below
      if (!/already|registered|exists/i.test(invErr.message || "")) throw new HttpError(502, invErr.message);
    } else invited = true;

    const { error: addErr } = await serviceClient(orgId).rpc("add_member", { p_email: addr, p_role: role_key, p_full_name: full_name || null });
    if (addErr) throw new HttpError(400, addErr.message);
    send(res, 200, { ok: true, invited });
  } catch (e) {
    send(res, e.status || 500, { error: e.status ? e.message : "server error" });
  }
}
