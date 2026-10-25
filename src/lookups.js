// Reference-data loaders used by forms (dropdowns). Each returns [{id, label, ...row}].
import { supabase, run, rpc } from "./supabase.js";

const label = (r) => [r.code, r.name_ar].filter(Boolean).join(" — ");

export async function accounts({ postable = true, cash } = {}) {
  let q = supabase.from("accounts").select("id, code, name_ar, name_en, type, is_group, is_cash, system_key").eq("active", true);
  if (postable) q = q.eq("is_group", false);
  if (cash) q = q.eq("is_cash", true);
  return (await run(q.order("code"))).map((r) => ({ ...r, label: label(r) }));
}
export async function customers() {
  return (await run(supabase.from("customers").select("*").eq("active", true).order("name_ar"))).map((r) => ({ ...r, label: label(r) }));
}
export async function vendors() {
  return (await run(supabase.from("vendors").select("*").eq("active", true).order("name_ar"))).map((r) => ({ ...r, label: label(r) }));
}
// projects, customer names and employees come through name-only lookups so a
// form in one module can offer them without access to the other module
export async function projects() {
  return ((await rpc("lookup_projects")) || []).map((r) => ({ ...r, label: label(r) }));
}
export async function customerNames() {
  return ((await rpc("lookup_customers")) || []).map((r) => ({ ...r, label: label(r) }));
}
export async function taxCodes() {
  return (await run(supabase.from("tax_codes").select("*").eq("active", true).order("rate", { ascending: false })))
    .map((r) => ({ ...r, label: r.name_ar }));
}
export async function items() {
  return (await run(supabase.from("items").select("*").eq("active", true).order("name_ar"))).map((r) => ({ ...r, label: label(r) }));
}
export async function departments() {
  return (await run(supabase.from("departments").select("*").order("name_ar"))).map((r) => ({ ...r, label: r.code ? `${r.code} — ${r.name_ar}` : r.name_ar }));
}
export async function employees() {
  return ((await rpc("lookup_employees")) || [])
    .map((r) => ({ ...r, label: `${r.code} — ${r.first_name_ar} ${r.last_name_ar}` }));
}
