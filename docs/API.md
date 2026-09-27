# GDXora API — دليل الربط

- **العنوان الأساسي:** `https://<your-domain>/api/v1`
- **المواصفات الكاملة:** `GET /api/v1/openapi.json` (OpenAPI 3.1)
- **المصادقة:** يُنشئ مدير النظام المفتاح من «الإعدادات ← الربط والتكامل»، ويُرسل مع كل طلب هكذا:

```
Authorization: Bearer gdx_<prefix>_<secret>
```

كل مفتاح مرتبط **بشركة واحدة** وبصلاحيات (scopes) محددة، مثل `invoices:read` و `invoices:write` و `customers:read` و `customers:write` و `accounts:read` و `reports:read` و `projects:read` و `vendors:read` و `employees:read`.

## أمثلة

```bash
# إنشاء فاتورة مبسطة وإصدارها مباشرة (ترقيم + ICV/PIH + قيد + XML/QR)
curl -X POST https://erp.example.com/api/v1/invoices \
  -H "Authorization: Bearer $GDX_KEY" -H "Content-Type: application/json" \
  -d '{"invoice_kind":"simplified","issue":true,
       "lines":[{"description":"اشتراك شهري","quantity":1,"unit_price":500,"tax_code":"VAT15"}]}'

# الفواتير الصادرة في فترة
curl "https://erp.example.com/api/v1/invoices?status=issued&from=2026-01-01&to=2026-03-31" -H "Authorization: Bearer $GDX_KEY"

# ملف XML لفاتورة
curl https://erp.example.com/api/v1/invoices/<id>/xml -H "Authorization: Bearer $GDX_KEY"

# ميزان المراجعة
curl "https://erp.example.com/api/v1/reports/trial-balance?to=2026-12-31" -H "Authorization: Bearer $GDX_KEY"
```

رموز الأخطاء:

| الرمز | المعنى |
|---|---|
| 401 | المفتاح غير صالح أو ملغى أو منتهٍ |
| 403 | المفتاح لا يملك الصلاحية المطلوبة |
| 422 | الطلب يخالف قاعدة عمل، والسبب مذكور في `error` |

## Webhooks

اشترك من «الإعدادات ← الربط والتكامل ← Webhooks». الأحداث المتاحة: `invoice.issued` و `bill.posted` و `payment.received` و `payment.made` و `payroll.posted` و `organization.created`. يمكن أيضاً استخدام أنماط مثل `invoice.*` أو `*` للاشتراك في مجموعة أحداث.

```http
POST <your-url>
X-GDXora-Event: invoice.issued
X-GDXora-Delivery: 1234
X-GDXora-Signature: t=1790000000,v1=5f2c…
Content-Type: application/json

{"id":1234,"type":"invoice.issued","org_id":"…","entity":"invoice","entity_id":"…",
 "data":{"number":"INV-00042","total":1150,"customer_id":"…"},"created_at":"…"}
```

**التحقق من التوقيع (Node):**

```js
import crypto from "node:crypto";
const [t, v1] = sig.split(",").map((p) => p.split("=")[1]);
const expected = crypto.createHmac("sha256", SECRET).update(`${t}.${rawBody}`).digest("hex");
const valid = crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected)) && Date.now() / 1000 - t < 300;
```

- الرد بأي رمز 2xx يؤكد الاستلام.
- إذا لم يصل رد 2xx، يعيد النظام المحاولة بعد دقيقة، ثم 5 دقائق، ثم 30 دقيقة، ثم ساعتين، ثم 12 ساعة، ويتوقف بعد 6 محاولات.
- قد يصل الحدث الواحد أكثر من مرة. استخدم `id` لتجاهل المكرر.
