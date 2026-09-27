# GDXora

*ERP for Smart Business*

**نظام تخطيط موارد المؤسسات (ERP) لشركات الخدمات والمقاولات في السعودية — متعدد الشركات، قابل للبيع كخدمة (SaaS)، ومفتوح للربط مع الأنظمة الأخرى.**

ERP for Saudi services & contracting companies. It is multi-tenant, built to be sold as SaaS, and integrates with other systems through an API and webhooks.

| الوحدة | ما تغطيه |
|---|---|
| **المحاسبة** | دليل حسابات سعودي جاهز · قيود يومية (مسودة ← ترحيل ← عكس) · ميزان المراجعة · قائمة الدخل والمركز المالي · كشف حساب · فترات مالية وإقفال |
| **الفوترة + ZATCA** | فواتير ضريبية (B2B) ومبسطة (B2C) · إشعارات دائنة ومدينة · UUID + عداد ICV + سلسلة PIH · ملف UBL XML · بصمة SHA-256 · رمز QR (TLV) · قيد محاسبي تلقائي |
| **المشاريع** | عقود · جدول كميات (BOQ) · مستخلصات مع محتجزات ضمان واسترداد الدفعة المقدمة · ميزانية · ربحية كل مشروع مباشرة من الأستاذ العام |
| **المالية** | موردون ومقاولو باطن · فواتير موردين (ضريبة مدخلات، محتجزات) · سندات قبض وصرف · أعمار الذمم · إقرار ضريبة القيمة المضافة |
| **الموارد البشرية والرواتب** | موظفون · إجازات وأرصدة · مسيّر رواتب شهري (أيام فعلية، إجازة بدون راتب، التأمينات الاجتماعية حسب النظام القديم ونظام 2024) · اعتماد وترحيل · ملف تحويل بنكي · مكافأة نهاية الخدمة (المادتان 84 و85) |
| **الربط والتكامل** | REST API `/api/v1` بمفاتيح لكل شركة وصلاحيات محددة · Webhooks موقّعة HMAC مع إعادة المحاولة · مواصفات OpenAPI |
| **المنصة** | عزل كامل بين الشركات داخل قاعدة البيانات (RLS) · أدوار وصلاحيات دقيقة · سجل تدقيق · عربي/إنجليزي · يعمل على الجوال |

## التقنيات · Stack

React 18 + Vite · Supabase (Postgres + Auth + PostgREST) · Vercel (static hosting + serverless `api/`)

القواعد المحاسبية والضريبية مطبّقة **داخل قاعدة البيانات**، في دوال وقيود و triggers وسياسات RLS، وليست في الواجهة. لذلك الواجهة وتطبيق الجوال المستقبلي والـ API والأنظمة الخارجية كلها تمر بنفس القواعد.

## التشغيل محلياً · Local development

```bash
npm install
npx supabase start            # local Supabase (Docker) — applies supabase/migrations automatically
cp .env.example .env.local    # put the API URL + anon key printed by `supabase start`
npm run dev                   # http://localhost:5173
```

## الاختبارات · Tests

```bash
npm test                      # unit tests: ZATCA QR/XML/hash, GOSI, end-of-service, validators
npm run test:db               # all migrations + SQL tests on a throwaway Postgres (PGHOST/PGUSER/PGPASSWORD)
npm run test:e2e              # full flow on a running Supabase (SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY)
```

## النشر · Deployment

1. أنشئ مشروع Supabase، ثم طبّق الملفات في `supabase/migrations` بالترتيب (`npx supabase db push`).
2. انشر المستودع على Vercel. أعدادات Vercel موجودة في `vercel.json`.
3. أضف متغيرات البيئة التالية في Vercel: `VITE_SUPABASE_URL` و `VITE_SUPABASE_ANON_KEY` و `SUPABASE_URL` و `SUPABASE_SERVICE_ROLE_KEY` و `CRON_SECRET`.
4. فعّل Cron في Vercel ليعمل مرسل الـ Webhooks (`/api/cron/webhooks` كل 5 دقائق). هذا يتطلب باقة Pro، أما الباقة المجانية فتسمح بتشغيله مرة يومياً فقط.

## الوثائق · Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — البنية وتعدد الشركات والأمان ونموذج البيانات
- [`docs/ZATCA.md`](docs/ZATCA.md) — الفوترة الإلكترونية: ما تم تنفيذه وخطوات المرحلة الثانية
- [`docs/API.md`](docs/API.md) — دليل الربط للمطوّرين
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — خطة التطوير والطرح التجاري
