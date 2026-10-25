// Shared helpers for serverless functions (files starting with "_" are not routes on Vercel).
import { createClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

/** service-role client; with orgId the DB treats x-org-id as the trusted org (migration 0009) */
export function serviceClient(orgId) {
  if (!URL_ || !SERVICE) throw Object.assign(new Error("server is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)"), { status: 500 });
  return createClient(URL_, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: orgId ? { "x-org-id": orgId } : {} },
  });
}

export function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

export async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error("invalid JSON body"), { status: 400 }); }
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/**
 * The signed-in user behind a request and their standing in the company named
 * by x-org-id. Throws 401/403. perm: required permission (owner passes).
 * @returns {{ user, orgId, admin }} admin = service-role client (bypasses RLS)
 */
export async function requireMember(req, perm) {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const orgId = String(req.headers["x-org-id"] || "");
  if (!token || !/^[0-9a-f-]{36}$/i.test(orgId)) throw new HttpError(401, "sign in required");
  const admin = serviceClient();
  const { data: who, error } = await admin.auth.getUser(token);
  if (error || !who?.user) throw new HttpError(401, "sign in required");
  const { data: m } = await admin.from("org_members").select("is_owner, role_key, active")
    .eq("org_id", orgId).eq("user_id", who.user.id).maybeSingle();
  if (!m?.active) throw new HttpError(403, "not a member of this company");
  if (perm && !m.is_owner) {
    const { data: rp } = await admin.from("role_permissions").select("perm_key")
      .eq("org_id", orgId).eq("role_key", m.role_key).eq("perm_key", perm).maybeSingle();
    if (!rp) throw new HttpError(403, `permission denied: ${perm}`);
  }
  return { user: who.user, orgId, admin };
}
