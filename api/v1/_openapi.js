// OpenAPI 3.1 description of the public API (served at /api/v1/openapi.json).
const money = { type: "number", format: "decimal", example: 1150.0 };
const id = { type: "string", format: "uuid" };
const list = (ref) => ({ type: "object", properties: { data: { type: "array", items: { $ref: ref } } } });
const one = (ref) => ({ type: "object", properties: { data: { $ref: ref } } });
const ok = (schema, description = "OK") => ({ description, content: { "application/json": { schema } } });
const errors = {
  401: { description: "Missing, invalid, revoked or expired API key", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
  403: { description: "The API key lacks the required scope", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
  422: { description: "Business rule violated (e.g. unbalanced, missing VAT number)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
};
const paging = [
  { name: "limit", in: "query", schema: { type: "integer", default: 100, maximum: 500 } },
  { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
];
const scope = (s) => ({ "x-required-scope": s, security: [{ apiKey: [] }] });

export const spec = {
  openapi: "3.1.0",
  info: {
    title: "GDXora API", version: "1.0.0",
    description: "REST API for GDXora ERP. Authenticate with an organization API key: `Authorization: Bearer gdx_…`. " +
      "Every key is bound to one company and a set of scopes. All business rules (VAT, ZATCA chain, double entry) are enforced server-side. " +
      "Events are pushed via signed webhooks: header `X-GDXora-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, \"<t>.<raw body>\")>`.",
  },
  servers: [{ url: "/api/v1" }],
  components: {
    securitySchemes: { apiKey: { type: "http", scheme: "bearer", bearerFormat: "gdx_<prefix>_<secret>" } },
    schemas: {
      Error: { type: "object", properties: { error: { type: "string" } } },
      Customer: { type: "object", properties: {
        id, code: { type: "string" }, name_ar: { type: "string" }, name_en: { type: "string" },
        customer_type: { enum: ["business", "individual", "government"] }, vat_number: { type: "string", pattern: "^3[0-9]{13}3$" },
        cr_number: { type: "string" }, street: { type: "string" }, building_no: { type: "string" }, district: { type: "string" },
        city: { type: "string" }, postal_code: { type: "string" }, country: { type: "string", default: "SA" },
        phone: { type: "string" }, email: { type: "string" }, payment_terms_days: { type: "integer" } } },
      InvoiceLineInput: { type: "object", required: ["description", "quantity", "unit_price"], properties: {
        description: { type: "string" }, quantity: { type: "number" }, unit_price: money, discount: money, unit: { type: "string" },
        tax_code: { type: "string", default: "VAT15", description: "VAT15 · ZR-EXP · ZR-GDS · EX-FIN · EX-RE · OOS (or a custom code)" } } },
      InvoiceInput: { type: "object", required: ["lines"], properties: {
        invoice_kind: { enum: ["standard", "simplified"], default: "standard" }, doc_type: { enum: ["invoice", "credit_note", "debit_note"], default: "invoice" },
        customer_id: id, project_id: id, ref_invoice_id: { ...id, description: "Required for credit/debit notes" }, reason: { type: "string" },
        issue_date: { type: "string", format: "date" }, supply_date: { type: "string", format: "date" }, due_date: { type: "string", format: "date" },
        retention_amount: money, notes: { type: "string" }, issue: { type: "boolean", default: false, description: "Issue immediately (assigns number, ICV/PIH, posts GL, builds XML/QR)" },
        lines: { type: "array", items: { $ref: "#/components/schemas/InvoiceLineInput" } } } },
      Invoice: { type: "object", properties: {
        id, number: { type: "string" }, doc_type: { type: "string" }, invoice_kind: { type: "string" }, status: { enum: ["draft", "issued"] },
        customer_id: id, project_id: id, issue_date: { type: "string" }, subtotal: money, taxable_amount: money, vat_amount: money, total: money,
        retention_amount: money, net_payable: money, amount_paid: money, zatca_uuid: id, zatca_icv: { type: "integer" },
        zatca_hash: { type: "string" }, zatca_qr: { type: "string", description: "Base64 TLV QR payload" }, zatca_status: { type: "string" },
        lines: { type: "array", items: { type: "object" } } } },
      Account: { type: "object", properties: { id, code: { type: "string" }, name_ar: { type: "string" }, type: { type: "string" }, is_group: { type: "boolean" } } },
      TrialBalanceRow: { type: "object", properties: { account_id: id, code: { type: "string" }, name_ar: { type: "string" }, type: { type: "string" },
        opening: money, debit: money, credit: money, closing: money } },
      WebhookEvent: { type: "object", properties: { id: { type: "integer" }, type: { type: "string", example: "invoice.issued" }, org_id: id,
        entity: { type: "string" }, entity_id: id, data: { type: "object" }, created_at: { type: "string", format: "date-time" } } },
    },
  },
  security: [{ apiKey: [] }],
  paths: {
    "/customers": {
      get: { summary: "List customers", ...scope("customers:read"), parameters: [...paging, { name: "search", in: "query", schema: { type: "string" } }],
             responses: { 200: ok(list("#/components/schemas/Customer")), ...errors } },
      post: { summary: "Create a customer", ...scope("customers:write"),
              requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Customer" } } } },
              responses: { 201: ok(one("#/components/schemas/Customer"), "Created"), ...errors } },
    },
    "/customers/{id}": { get: { summary: "Get a customer", ...scope("customers:read"), parameters: [{ name: "id", in: "path", required: true, schema: id }],
                                responses: { 200: ok(one("#/components/schemas/Customer")), ...errors } } },
    "/invoices": {
      get: { summary: "List invoices", ...scope("invoices:read"), parameters: [...paging,
               { name: "status", in: "query", schema: { enum: ["draft", "issued"] } }, { name: "from", in: "query", schema: { type: "string", format: "date" } },
               { name: "to", in: "query", schema: { type: "string", format: "date" } }, { name: "customer_id", in: "query", schema: id }],
             responses: { 200: ok(list("#/components/schemas/Invoice")), ...errors } },
      post: { summary: "Create an invoice (draft, or issue immediately)", ...scope("invoices:write"),
              requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/InvoiceInput" } } } },
              responses: { 201: ok(one("#/components/schemas/Invoice"), "Created"), ...errors } },
    },
    "/invoices/{id}": { get: { summary: "Get an invoice with lines", ...scope("invoices:read"), parameters: [{ name: "id", in: "path", required: true, schema: id }],
                               responses: { 200: ok(one("#/components/schemas/Invoice")), ...errors } } },
    "/invoices/{id}/issue": { post: { summary: "Issue a draft invoice (ZATCA numbering, hash, QR, GL posting)", ...scope("invoices:write"),
                                      parameters: [{ name: "id", in: "path", required: true, schema: id }], responses: { 200: ok(one("#/components/schemas/Invoice")), ...errors } } },
    "/invoices/{id}/xml": { get: { summary: "Download the ZATCA UBL XML", ...scope("invoices:read"), parameters: [{ name: "id", in: "path", required: true, schema: id }],
                                   responses: { 200: { description: "UBL 2.1 XML", content: { "application/xml": {} } }, ...errors } } },
    "/accounts": { get: { summary: "Chart of accounts", ...scope("accounts:read"), responses: { 200: ok(list("#/components/schemas/Account")), ...errors } } },
    "/reports/trial-balance": { get: { summary: "Trial balance", ...scope("reports:read"),
      parameters: [{ name: "from", in: "query", schema: { type: "string", format: "date" } }, { name: "to", in: "query", schema: { type: "string", format: "date" } }],
      responses: { 200: ok(list("#/components/schemas/TrialBalanceRow")), ...errors } } },
    "/reports/projects": { get: { summary: "Project profitability", ...scope("reports:read"), responses: { 200: ok({ type: "object" }), ...errors } } },
    "/projects": { get: { summary: "List projects", ...scope("projects:read"), parameters: paging, responses: { 200: ok({ type: "object" }), ...errors } } },
    "/vendors": { get: { summary: "List vendors", ...scope("vendors:read"), parameters: paging, responses: { 200: ok({ type: "object" }), ...errors } } },
    "/employees": { get: { summary: "List employees (no salary or ID data)", ...scope("employees:read"), parameters: paging, responses: { 200: ok({ type: "object" }), ...errors } } },
  },
  webhooks: {
    event: { post: { summary: "Domain event (invoice.issued, bill.posted, payment.received, payment.made, payroll.posted, organization.created)",
                     requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/WebhookEvent" } } } },
                     responses: { 200: { description: "Return 2xx to acknowledge; otherwise retried with backoff (1m, 5m, 30m, 2h, 12h)" } } } },
  },
};
