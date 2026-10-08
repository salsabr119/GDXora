-- ════════════════════════════════════════════════════════════════════════
-- GDXora · 0011 — Company branding & contact details for documents
-- ════════════════════════════════════════════════════════════════════════
-- Each tenant prints its own logo, contact details and bank account on its
-- invoices. The logo is a small data URL (PNG/JPEG, resized in the browser to
-- ≤ 512 px) so documents and PDFs embed it without cross-origin fetches.
-- ════════════════════════════════════════════════════════════════════════

alter table organizations
  add column logo_data      text,
  add column phone          text,
  add column email          text,
  add column website        text,
  add column bank_name      text,
  add column iban           text,
  add column invoice_footer text,
  add constraint org_logo_data_format check (logo_data is null or (logo_data ~ '^data:image/(png|jpeg|webp);base64,' and length(logo_data) <= 400000)),
  add constraint org_iban_format check (iban is null or iban ~ '^SA[0-9]{22}$');
