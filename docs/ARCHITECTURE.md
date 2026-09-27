# GDXora — البنية المعمارية · Architecture

## 1. المبادئ

1. **القواعد في قاعدة البيانات.** كل قاعدة عمل حسّاسة (توازن القيد، عدم تعديل المستند بعد إصدار الفاتورة، سلسلة ZATCA، التأمينات، الصلاحيات) مكتوبة في Postgres كدوال ومحفّزات (triggers) وقيود وسياسات RLS. الواجهة والـ API والأنظمة الخارجية كلها عملاء لنفس القواعد، ولا يوجد طريق للالتفاف عليها.
2. **تعدد الشركات من اليوم الأول.** كل صف في كل جدول ينتمي إلى `org_id`، والعزل بين الشركات تفرضه RLS.
3. **API-first، والتكامل عبر الأحداث.** كل عملية مهمة تكتب حدثاً في جدول `outbox` داخل نفس المعاملة (transaction). الـ Webhooks والوحدات المستقبلية تستهلك هذه الأحداث، فلا تستدعي الوحدات بعضها مباشرة.
4. **لا شيء يُحذف من الدفاتر.** القيود المرحّلة والفواتير الصادرة والسندات لا تُعدَّل ولا تُحذف. التصحيح يكون بقيد عكسي أو بإشعار دائن/مدين.

## 2. المكوّنات

```
Browser (React, RTL/LTR) ──┐
Mobile (future)  ──────────┼──► Supabase: Auth · PostgREST · Postgres (RLS + RPC)
External systems ──► /api/v1 (Vercel, API key → service context) ──┘
                                        │
                     outbox ──► webhook_deliveries ──► /api/cron/webhooks ──► subscriber URLs (HMAC)
```

| المجلد | المحتوى |
|---|---|
| `supabase/migrations/` | المخطط الكامل: جداول، دوال، RLS، بيانات البداية |
| `supabase/tests/` | اختبارات SQL (تعمل على Postgres عادي باستخدام `00_supabase_shim.sql`) |
| `src/lib/zatca/` | مكتبة ZATCA: TLV/QR، وUBL XML، وبصمة الفاتورة. تعمل في المتصفح وفي Node |
| `src/lib/payroll.js` | معادلات التأمينات ومكافأة نهاية الخدمة. تطابق SQL وأرقامها مغطاة بالاختبارات |
| `src/screens/` | الشاشات حسب الوحدة؛ `src/nav.js` هو سجلّ الوحدات والصلاحيات |
| `src/crud.jsx` | محرّك القوائم والنماذج للبيانات الأساسية |
| `api/v1/` | الـ REST API العام + مواصفات OpenAPI |
| `api/cron/webhooks.js` | مرسل الـ Webhooks |

## 3. تعدد الشركات والأمان

- الشركة النشطة ترسلها الواجهة في الترويسة `x-org-id` مع كل طلب.
- الدالة `current_org_id()` تُرجع الشركة **فقط** إذا كان المستخدم عضواً نشطاً فيها. أي ترويسة مزوّرة تعطي `NULL`، فترفض كل السياسات الطلب. هذا مُختبَر في `10_erp_flow_test.sql` وفي `scripts/e2e.mjs`.
- `has_perm(key)` تتحقق من صلاحيات دور المستخدم داخل الشركة. مالك الشركة يملك كل الصلاحيات.
- **الأعمدة الحسّاسة محمية بصلاحيات على مستوى العمود (column grants).** المستخدم لا يستطيع كتابة `status` أو `number` أو المبالغ المحسوبة أو حقول ZATCA أو `amount_paid` مباشرة، وهذه الحقول تتغير فقط عبر دوال `security definer`، مثل `issue_invoice` و `post_payment` و `post_payroll`.
- **سياق الـ API (migration 0009):** خادم الـ API يتحقق من مفتاح الـ API، ثم يستدعي Supabase بمفتاح `service_role` ويضع شركة المفتاح في `x-org-id`. قاعدة البيانات تثق بالترويسة لهذا الدور وحده (الدور يُقرأ من الـ JWT لا من الترويسة)، فتعمل نفس الدوال بنفس القواعد. صلاحيات المفتاح (scopes) يتحقق منها الـ API قبل الاستدعاء.
- مفاتيح الـ API تُخزَّن كبصمة SHA-256 فقط، ولا يستطيع أي مستخدم قراءة عمود البصمة.

## 4. نموذج البيانات (مختصر)

| المجال | الجداول |
|---|---|
| الأساس | `organizations`, `org_members`, `roles`, `role_permissions`, `permissions`, `org_modules`, `doc_sequences`, `audit_log`, `outbox` |
| المحاسبة | `accounts` (شجرة + `system_key`)، `fiscal_periods`، `journal_entries`، `journal_lines` (مع `project_id` و party) |
| المبيعات | `customers`, `items`, `tax_codes`, `invoices`, `invoice_lines`, `zatca_state` |
| المشاريع | `projects`, `project_boq_items`, `project_budget_lines`, `progress_billings`, `progress_billing_lines` |
| المالية | `vendors`, `bills`, `bill_lines`, `payments` |
| الموارد البشرية | `departments`, `employees`, `leave_requests`, `payroll_settings`, `gosi_annuity_schedule`, `payroll_runs`, `payroll_lines` |
| التكامل | `api_keys`, `webhooks`, `webhook_deliveries` |

### الربط المحاسبي التلقائي

كل وحدة تُرحّل عبر `gl_post()` إلى حسابات معرّفة بـ `system_key`. لذلك لو غيّرت الشركة أرقام دليل حساباتها، يستمر الترحيل الآلي في العمل.

| المستند | القيد |
|---|---|
| فاتورة مبيعات | من ح/ العملاء (الصافي) + المحتجزات + استرداد الدفعة المقدمة ← إلى ح/ الإيرادات + ضريبة المخرجات |
| إشعار دائن | عكس القيد السابق |
| فاتورة مورد | من ح/ المصروف أو التكلفة (لكل مشروع) + ضريبة المدخلات ← إلى ح/ الموردين + محتجزات مقاولي الباطن |
| سند قبض/صرف | الصندوق أو البنك ↔ العملاء / الموردين / الدفعات المقدمة / الرواتب / التأمينات / أي حساب آخر |
| مسيّر الرواتب | من ح/ الرواتب (أو عمالة المشروع) + حصة المنشأة في التأمينات ← إلى ح/ التأمينات المستحقة + السلف + الرواتب المستحقة |

## 5. إضافة وحدة جديدة

1. أنشئ migration جديداً: الجداول، ثم `select apply_org_policies('table', 'x.view', 'x.manage')`، ثم الصلاحيات في `permissions`، ثم الدوال.
2. أضف اختبار SQL في `supabase/tests/`.
3. أنشئ الشاشات في `src/screens/` وسجّلها في `src/nav.js`.
4. اكتب الأحداث عبر `emit_event()` حتى تصل تلقائياً إلى الـ Webhooks.
