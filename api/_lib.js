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
