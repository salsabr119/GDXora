// End-to-end test against a running Supabase (default: `npx supabase start`).
// Exercises the real Auth + PostgREST + RLS path the app uses, the ZATCA
// library, and the public REST API router.
//   SUPABASE_URL=… SUPABASE_ANON_KEY=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/e2e.mjs
// Against a deployment (no service key needed — the public API is called over HTTP):
//   SUPABASE_URL=… SUPABASE_ANON_KEY=… API_BASE=https://your-app.vercel.app/api/v1 node scripts/e2e.mjs
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { processInvoice, decodeQr } from "../src/lib/zatca/index.js";

const URL_ = process.env.SUPABASE_URL || "http://127.0.0.1:54321";
const ANON = process.env.SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const API_BASE = process.env.API_BASE;
if (!ANON || (!SERVICE && !API_BASE)) { console.error("set SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY (or API_BASE)"); process.exit(2); }
process.env.SUPABASE_URL = URL_;

const stamp = Date.now();
const DOMAIN = process.env.E2E_EMAIL_DOMAIN || "example.com";
let step = 0;
const ok = (msg) => console.log(`  ✓ ${String(++step).padStart(2, "0")} ${msg}`);
const must = ({ data, error }) => { if (error) throw new Error(error.message); return data; };

// a client that sends the org header like the app does
function userClient() {
  let org = null;
  const c = createClient(URL_, ANON, {
    auth: { persistSession: false },
    global: { fetch: (i, init = {}) => { const h = new Headers(init.headers || {}); if (org) h.set("x-org-id", org); return fetch(i, { ...init, headers: h }); } },
  });
  c.setOrg = (id) => { org = id; };
  return c;
}
async function signUp(email) {
  const c = userClient();
  must(await c.auth.signUp({ email, password: "Passw0rd!Passw0rd", options: { data: { full_name: email.split("@")[0] } } }));
  return c;
}

console.log("GDXora e2e —", URL_);
const alice = await signUp(`alice.${stamp}@${DOMAIN}`);
const mallory = await signUp(`mallory.${stamp}@${DOMAIN}`);
ok("sign-up (Supabase Auth)");

const orgA = must(await alice.rpc("create_organization", { p_name_ar: "شركة الأفق للمقاولات", p_name_en: "Horizon Contracting", p_vat_number: "300000000000003", p_cr_number: "1010999999" }));
alice.setOrg(orgA);
must(await alice.from("organizations").update({ legal_name: "شركة الأفق للمقاولات المحدودة", street: "طريق الملك فهد", building_no: "1234", district: "العليا", city: "الرياض", postal_code: "12211" }).eq("id", orgA));
const orgM = must(await mallory.rpc("create_organization", { p_name_ar: "شركة أخرى" }));
mallory.setOrg(orgM);
ok("onboarding creates isolated companies with defaults");

const perms = must(await alice.rpc("my_permissions"));
assert.ok(perms.includes("sales.issue") && perms.length >= 20);
assert.equal(must(await alice.from("accounts").select("id")).length >= 45, true);

// isolation through the real REST API
mallory.setOrg(orgA);                         // forged header
assert.equal(must(await mallory.from("accounts").select("id")).length, 0);
assert.equal(must(await mallory.from("organizations").select("id").eq("id", orgA)).length, 0);
const forged = await mallory.from("customers").insert({ org_id: orgA, name_ar: "حقن" });
assert.ok(forged.error, "forged insert must fail");
mallory.setOrg(orgM);
ok("tenant isolation holds over REST (forged x-org-id rejected)");

// customer + invoice → issue → ZATCA
const cust = must(await alice.from("customers").insert({ name_ar: "وزارة النموذج", customer_type: "business", vat_number: "310000000000003",
  street: "شارع التحلية", building_no: "7788", district: "السليمانية", city: "الرياض", postal_code: "12245" }).select().single());
const tax = must(await alice.from("tax_codes").select("id").eq("code", "VAT15").single());
const inv = must(await alice.from("invoices").insert({ customer_id: cust.id, invoice_kind: "standard" }).select().single());
must(await alice.from("invoice_lines").insert([
  { invoice_id: inv.id, line_no: 1, description: "تصميم هندسي", quantity: 1, unit_price: 20000, discount: 0, tax_code_id: tax.id },
  { invoice_id: inv.id, line_no: 2, description: "إشراف — شهر", quantity: 3, unit_price: 5000, discount: 1000, tax_code_id: tax.id },
]));
const draft = must(await alice.from("invoices").select("subtotal, vat_amount, total").eq("id", inv.id).single());
assert.deepEqual([+draft.subtotal, +draft.vat_amount, +draft.total], [34000, 5100, 39100]);
const issued = must(await alice.rpc("issue_invoice", { p_invoice: inv.id }));
assert.equal(issued.number, "INV-00001");

const full = must(await alice.from("invoices").select("*").eq("id", inv.id).single());
const lines = must(await alice.from("invoice_lines").select("*").eq("invoice_id", inv.id).order("line_no"));
const seller = must(await alice.from("organizations").select("*").eq("id", orgA).single());
const z = await processInvoice({ invoice: full, lines, seller, buyer: cust });
must(await alice.rpc("zatca_attach", { p_invoice: inv.id, p_hash: z.hash, p_qr: z.qr, p_xml: z.xml }));
const qr = decodeQr(z.qr);
assert.equal(qr[1], "شركة الأفق للمقاولات المحدودة");
assert.equal(qr[4], "39100.00");
ok(`invoice issued ${issued.number} · ICV ${issued.icv} · hash ${z.hash.slice(0, 12)}… · QR decodes`);

const upd = await alice.from("invoices").update({ notes: "tamper" }).eq("id", inv.id);
assert.ok(upd.error && /immutable/.test(upd.error.message));
const st = await alice.from("invoices").update({ status: "draft" }).eq("id", inv.id);
assert.ok(st.error, "status column must not be writable");
ok("issued invoice is immutable over REST");

// receipt
const bank = must(await alice.from("accounts").select("id").eq("system_key", "bank").single());
const rv = must(await alice.from("payments").insert({ direction: "receipt", purpose: "invoice", account_id: bank.id, amount: 39100, invoice_id: inv.id }).select().single());
assert.equal(must(await alice.rpc("post_payment", { p_payment: rv.id })), "RV-00001");
ok("receipt voucher posted");

// payroll
must(await alice.from("employees").insert([
  { first_name_ar: "نواف", last_name_ar: "الشهري", nationality: "SA", hire_date: "2022-03-01", basic_salary: 12000, housing_allowance: 3000, transport_allowance: 1000 },
  { first_name_ar: "أحمد", last_name_ar: "حسن", nationality: "EG", hire_date: "2024-01-15", basic_salary: 6000, housing_allowance: 1500 },
], { defaultToNull: false }));
const run = must(await alice.rpc("generate_payroll", { p_period: "2026-08" }));
must(await alice.rpc("approve_payroll", { p_run: run }));
must(await alice.rpc("post_payroll", { p_run: run }));
const pr = must(await alice.from("payroll_runs").select("*").eq("id", run).single());
assert.equal(+pr.total_gosi_employee, 1462.5);          // 15000 × 9.75%
assert.equal(+pr.total_gosi_employer, 1762.5 + 150);     // 15000 × 11.75% + 7500 × 2%
ok(`payroll 2026-08 posted · net ${pr.total_net}`);

// ledger integrity via the app's own report
const tb = must(await alice.rpc("trial_balance", {}));
const sum = (k) => tb.reduce((n, r) => n + Number(r[k]), 0);
assert.equal(Math.round(sum("debit") * 100), Math.round(sum("credit") * 100));
ok("trial balance balances");

// public API through the real router (service role + API key)
const apiKey = must(await alice.rpc("create_api_key", { p_name: "e2e", p_scopes: ["invoices:read", "invoices:write", "customers:read"] }));
const { route } = API_BASE ? {} : await import("../api/v1/_router.js");
async function call(method, path, body, key = apiKey) {
  if (API_BASE) {
    const r = await fetch(`${API_BASE}/${path}`, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
                                                   body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    return { status: r.status, json: (r.headers.get("content-type") || "").includes("json") ? JSON.parse(text) : text };
  }
  const req = { method, url: `/api/v1/${path}`, headers: { authorization: `Bearer ${key}` }, body };
  const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; } };
  try { await route(req, res, path.split("?")[0].split("/").filter(Boolean)); }
  catch (e) { res.statusCode = e.status || 500; res.body = JSON.stringify({ error: e.message }); }
  return { status: res.statusCode, json: res.headers["Content-Type"]?.includes("json") ? JSON.parse(res.body) : res.body };
}
let r = await call("GET", "invoices?status=issued");
assert.equal(r.status, 200); assert.equal(r.json.data.length, 1);
r = await call("POST", "invoices", { invoice_kind: "simplified", issue: true, lines: [{ description: "استشارة عبر API", quantity: 2, unit_price: 750 }] });
assert.equal(r.status, 201, JSON.stringify(r.json));
assert.equal(r.json.data.number, "INV-00002"); assert.equal(+r.json.data.total, 1725); assert.ok(r.json.data.zatca_hash);
const pih2 = must(await alice.from("invoices").select("zatca_pih").eq("id", r.json.data.id).single()).zatca_pih;
assert.equal(pih2, z.hash, "API invoice chains to the previous hash");
r = await call("GET", `invoices/${r.json.data.id}/xml`);
assert.equal(r.status, 200); assert.ok(r.json.includes("<cbc:ID>INV-00002</cbc:ID>"));
r = await call("GET", "accounts");
assert.equal(r.status, 403);
r = await call("GET", "invoices", null, apiKey.slice(0, -1) + (apiKey.endsWith("0") ? "1" : "0"));
assert.equal(r.status, 401);
ok("public API: list, create+issue (ZATCA chain continues), XML, scope 403, bad key 401");

// webhooks enqueue on events
must(await alice.from("webhooks").insert({ url: "https://example.com/hook", events: ["payment.*"] }));
const rv2 = must(await alice.from("payments").insert({ direction: "payment", purpose: "other", account_id: bank.id, amount: 500,
  counter_account_id: must(await alice.from("accounts").select("id").eq("system_key", "rent").single()).id }).select().single());
must(await alice.rpc("post_payment", { p_payment: rv2.id }));
assert.equal(must(await alice.from("webhook_deliveries").select("id")).length, 1);
ok("webhook delivery queued for payment.made");

console.log("✓ e2e passed");
