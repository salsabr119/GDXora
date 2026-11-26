# GDXora — notes for contributors & AI sessions

- Multi-tenant ERP (Saudi services/contracting). React 18 + Vite, Supabase, Vercel. Arabic-first (RTL) with English.
- **Business rules live in Postgres** (`supabase/migrations/`), not the UI. New tables: add `org_id`, then
  `select apply_org_policies(table, view_perm, manage_perm)`; status/number/total columns are written only by
  `security definer` functions (revoke column update, grant the editable ones). Posted/issued documents are immutable.
- Supabase keeps extensions in schema `extensions` — call `extensions.digest(...)`, `extensions.gen_random_bytes(...)`.
- Modules post to the ledger with `gl_post(org, date, memo, source_type, source_id, lines)` using account `system_key`s,
  and emit events with `emit_event()`.
- UI: screens in `src/screens/`, registered in `src/nav.js` (permission-gated). Master data uses `Resource` (`src/crud.jsx`).
  Bilingual strings inline: `t("عربي", "English")`.
- **Validation rule (UX):** never disable a submit button to signal missing input. On submit, collect problems and show them
  with `useIssues()` + `<Issues/>` (red box titled «الرجاء إكمال ما يلي…»), and mark fields/lines via `invalid`. Master-data
  forms get this from `validateRecord()` (field `required` / `validate`). Server errors still surface as red toasts.
- ZATCA library `src/lib/zatca/` is isomorphic (browser + Node); keep `tests/zatca.test.js` green (includes the official QR vector).
- Payroll formulas exist in SQL (authoritative) and `src/lib/payroll.js` — change both and both tests.

## Checks before pushing
```bash
npm test && npm run build
PGHOST=… PGUSER=… ./scripts/test-db.sh          # plain Postgres 16
node scripts/e2e.mjs                              # with `npx supabase start` running
```
