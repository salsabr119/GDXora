// Supabase client. The active company travels as the `x-org-id` header on
// every request; the database only honours it for members of that company.
import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

let currentOrg = null;
try { currentOrg = localStorage.getItem("gdx_org") || null; } catch { /* storage blocked */ }

export function setOrg(id) {
  currentOrg = id || null;
  try { id ? localStorage.setItem("gdx_org", id) : localStorage.removeItem("gdx_org"); } catch { /* ignore */ }
}
export const getOrg = () => currentOrg;

function orgFetch(input, init = {}) {
  const headers = new Headers(init.headers || {});
  if (currentOrg) headers.set("x-org-id", currentOrg);
  return fetch(input, { ...init, headers });
}

export const configured = Boolean(url && key);
export const supabase = configured
  ? createClient(url, key, { global: { fetch: orgFetch }, auth: { persistSession: true } })
  : null;

/** Call an RPC and throw a readable error on failure. */
export async function rpc(fn, args) {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw error;
  return data;
}

/** Await a query builder and throw on error. */
export async function run(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data;
}
