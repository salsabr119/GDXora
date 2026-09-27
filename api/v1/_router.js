// Public REST API v1 — business logic stays in the database (same RPCs the app
// uses); this layer authenticates API keys, enforces scopes and shapes JSON.
import { serviceClient, send, readJson, HttpError } from "../_lib.js";
import { processInvoice } from "../../src/lib/zatca/index.js";
import { spec } from "./_openapi.js";

const must = ({ data, error }) => {
  if (error) throw new HttpError(error.code === "42501" ? 403 : 422, error.message);
  return data;
};

async function authenticate(req) {
  const h = req.headers.authorization || "";
  const key = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!/^gdx_[0-9a-f]{12}_[0-9a-f]{48}$/.test(key)) throw new HttpError(401, "missing or malformed API key");
  const rows = must(await serviceClient().rpc("verify_api_key", { p_key: key }));
  if (!rows?.length) throw new HttpError(401, "invalid, revoked or expired API key");
  return { orgId: rows[0].org_id, scopes: new Set(rows[0].scopes) };
}
const need = (ctx, scope) => { if (!ctx.scopes.has(scope)) throw new HttpError(403, `API key lacks scope "${scope}"`); };
const page = (q) => {
  const limit = Math.min(Math.max(parseInt(q.limit || "100", 10) || 100, 1), 500);
  const offset = Math.max(parseInt(q.offset || "0", 10) || 0, 0);
  return [offset, offset + limit - 1];
};

async function zatca(db, orgId, id) {
  const inv = must(await db.from("invoices").select("*").eq("org_id", orgId).eq("id", id).single());
  const lines = must(await db.from("invoice_lines").select("*, tax_codes(exemption_code, exemption_reason)").eq("invoice_id", id).order("line_no"));
  const seller = must(await db.from("organizations").select("*").eq("id", orgId).single());
  const buyer = inv.customer_id ? must(await db.from("customers").select("*").eq("id", inv.customer_id).single()) : null;
  const ref = inv.ref_invoice_id ? must(await db.from("invoices").select("number").eq("id", inv.ref_invoice_id).single()) : null;
  const r = await processInvoice({ invoice: inv, seller, buyer, refNumber: ref?.number,
    lines: lines.map((l) => ({ ...l, exemption_code: l.tax_codes?.exemption_code, exemption_reason: l.tax_codes?.exemption_reason })) });
  must(await db.rpc("zatca_attach", { p_invoice: id, p_hash: r.hash, p_qr: r.qr, p_xml: r.xml }));
}

const INVOICE_COLS = "id, number, doc_type, invoice_kind, status, customer_id, project_id, issue_date, issue_time, supply_date, due_date, currency, subtotal, advance_deduction, taxable_amount, vat_amount, total, retention_amount, net_payable, amount_paid, zatca_uuid, zatca_icv, zatca_hash, zatca_qr, zatca_status, created_at";

export async function route(req, res, segments) {
  const method = req.method;
  const q = Object.fromEntries(new URL(req.url, "http://x").searchParams);
  const [a, b, c] = segments;

  if (method === "GET" && a === "openapi.json") return send(res, 200, spec);
  if (method === "GET" && !a) return send(res, 200, { name: "GDXora API", version: "v1", docs: "/api/v1/openapi.json" });

  const ctx = await authenticate(req);
  const db = serviceClient(ctx.orgId);
  const org = ctx.orgId;

  // customers
  if (a === "customers" && !b && method === "GET") {
    need(ctx, "customers:read");
    let qb = db.from("customers").select("*").eq("org_id", org).order("name_ar").range(...page(q));
    if (q.search) qb = qb.ilike("name_ar", `%${q.search}%`);
    return send(res, 200, { data: must(await qb) });
  }
  if (a === "customers" && b && method === "GET") {
    need(ctx, "customers:read");
    return send(res, 200, { data: must(await db.from("customers").select("*").eq("org_id", org).eq("id", b).single()) });
  }
  if (a === "customers" && !b && method === "POST") {
    need(ctx, "customers:write");
    const body = await readJson(req);
    const allowed = ["code", "name_ar", "name_en", "customer_type", "vat_number", "cr_number", "street", "building_no", "district",
                     "city", "postal_code", "country", "phone", "email", "payment_terms_days", "credit_limit", "notes"];
    const rec = Object.fromEntries(allowed.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));
    if (!rec.name_ar) throw new HttpError(422, "name_ar is required");
    return send(res, 201, { data: must(await db.from("customers").insert({ ...rec, org_id: org }).select().single()) });
  }

  // invoices
  if (a === "invoices" && !b && method === "GET") {
    need(ctx, "invoices:read");
    let qb = db.from("invoices").select(INVOICE_COLS).eq("org_id", org).order("created_at", { ascending: false }).range(...page(q));
    if (q.status) qb = qb.eq("status", q.status);
    if (q.from) qb = qb.gte("issue_date", q.from);
    if (q.to) qb = qb.lte("issue_date", q.to);
    if (q.customer_id) qb = qb.eq("customer_id", q.customer_id);
    return send(res, 200, { data: must(await qb) });
  }
  if (a === "invoices" && b && !c && method === "GET") {
    need(ctx, "invoices:read");
    const inv = must(await db.from("invoices").select(INVOICE_COLS).eq("org_id", org).eq("id", b).single());
    const lines = must(await db.from("invoice_lines").select("line_no, description, unit, quantity, unit_price, discount, tax_rate, tax_category, line_net, line_vat, line_total").eq("invoice_id", b).order("line_no"));
    return send(res, 200, { data: { ...inv, lines } });
  }
  if (a === "invoices" && b && c === "xml" && method === "GET") {
    need(ctx, "invoices:read");
    const inv = must(await db.from("invoices").select("number, zatca_xml").eq("org_id", org).eq("id", b).single());
    if (!inv.zatca_xml) throw new HttpError(404, "invoice has no ZATCA XML yet");
    res.statusCode = 200; res.setHeader("Content-Type", "application/xml; charset=utf-8");
    return res.end(`<?xml version="1.0" encoding="UTF-8"?>\n${inv.zatca_xml}`);
  }
  if (a === "invoices" && !b && method === "POST") {
    need(ctx, "invoices:write");
    const body = await readJson(req);
    if (!Array.isArray(body.lines) || !body.lines.length) throw new HttpError(422, "lines[] is required");
    const std = must(await db.from("tax_codes").select("id, code").eq("org_id", org).eq("active", true));
    const byCode = Object.fromEntries(std.map((x) => [x.code, x.id]));
    const header = {
      org_id: org, invoice_kind: body.invoice_kind || "standard", doc_type: body.doc_type || "invoice",
      customer_id: body.customer_id || null, project_id: body.project_id || null, ref_invoice_id: body.ref_invoice_id || null,
      reason: body.reason || null, issue_date: body.issue_date || null, supply_date: body.supply_date || null,
      due_date: body.due_date || null, retention_amount: Number(body.retention_amount || 0), notes: body.notes || null,
    };
    const inv = must(await db.from("invoices").insert(header).select("id").single());
    const rows = body.lines.map((l, i) => ({
      org_id: org, invoice_id: inv.id, line_no: i + 1, description: String(l.description || "").slice(0, 1000),
      unit: l.unit || null, quantity: Number(l.quantity || 1), unit_price: Number(l.unit_price || 0), discount: Number(l.discount || 0),
      tax_code_id: byCode[l.tax_code || "VAT15"] || byCode.VAT15,
    }));
    const ins = await db.from("invoice_lines").insert(rows);
    if (ins.error) { await db.from("invoices").delete().eq("id", inv.id); must(ins); }
    let issued = null;
    if (body.issue) {
      issued = must(await db.rpc("issue_invoice", { p_invoice: inv.id }));
      await zatca(db, org, inv.id);
    }
    const out = must(await db.from("invoices").select(INVOICE_COLS).eq("id", inv.id).single());
    return send(res, 201, { data: out, issued: Boolean(issued) });
  }
  if (a === "invoices" && b && c === "issue" && method === "POST") {
    need(ctx, "invoices:write");
    must(await db.rpc("issue_invoice", { p_invoice: b }));
    await zatca(db, org, b);
    return send(res, 200, { data: must(await db.from("invoices").select(INVOICE_COLS).eq("id", b).single()) });
  }

  // reference data & reports
  if (a === "accounts" && method === "GET") {
    need(ctx, "accounts:read");
    return send(res, 200, { data: must(await db.from("accounts").select("id, code, name_ar, name_en, type, parent_id, is_group, system_key, active").eq("org_id", org).order("code")) });
  }
  if (a === "reports" && b === "trial-balance" && method === "GET") {
    need(ctx, "reports:read");
    return send(res, 200, { data: must(await db.rpc("trial_balance", { p_from: q.from || null, p_to: q.to || null })) });
  }
  if (a === "reports" && b === "projects" && method === "GET") {
    need(ctx, "reports:read");
    return send(res, 200, { data: must(await db.rpc("project_summary", {})) });
  }
  if (a === "projects" && method === "GET") {
    need(ctx, "projects:read");
    return send(res, 200, { data: must(await db.from("projects").select("*").eq("org_id", org).order("code").range(...page(q))) });
  }
  if (a === "vendors" && method === "GET") {
    need(ctx, "vendors:read");
    return send(res, 200, { data: must(await db.from("vendors").select("id, code, name_ar, name_en, vendor_type, vat_number, cr_number, city, phone, email, active").eq("org_id", org).order("name_ar").range(...page(q))) });
  }
  if (a === "employees" && method === "GET") {
    need(ctx, "employees:read");
    // salaries and IDs are deliberately not exposed through the public API
    return send(res, 200, { data: must(await db.from("employees").select("id, code, first_name_ar, last_name_ar, first_name_en, last_name_en, job_title, department_id, project_id, hire_date, status").eq("org_id", org).order("code").range(...page(q))) });
  }

  throw new HttpError(404, `no route for ${method} /${segments.join("/")}`);
}
