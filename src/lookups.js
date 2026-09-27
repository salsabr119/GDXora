// Reference-data loaders used by forms (dropdowns). Each returns [{id, label, ...row}].
import { supabase, run } from "./supabase.js";

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
export async function projects() {
  return (await run(supabase.from("projects").select("id, code, name_ar, name_en, customer_id, status, retention_pct").order("code")))
    .map((r) => ({ ...r, label: label(r) }));
}
export async function taxCodes() {
  return (await run(supabase.from("tax_codes").select("*").eq("active", true).order("rate", { ascending: false })))
    .map((r) => ({ ...r, label: r.name_ar }));
}
export async function items() {
  return (await run(supabase.from("items").select("*").eq("active", true).order("name_ar"))).map((r) => ({ ...r, label: label(r) }));
}
export async function departments() {
  return (await run(supabase.from("departments").select("*").order("name_ar"))).map((r) => ({ ...r, label: r.name_ar }));
}
export async function employees() {
  return (await run(supabase.from("employees").select("id, code, first_name_ar, last_name_ar, status").order("code")))
    .map((r) => ({ ...r, label: `${r.code} — ${r.first_name_ar} ${r.last_name_ar}` }));
}
