// Map database errors to messages a non-technical user understands.
const RULES = [
  [/not balanced/i, "القيد غير متوازن — مجموع المدين لا يساوي مجموع الدائن", "Entry is not balanced (debit ≠ credit)"],
  [/at least two lines/i, "القيد يحتاج سطرين على الأقل", "An entry needs at least two lines"],
  [/group, inactive or foreign/i, "لا يمكن الترحيل على حساب رئيسي أو موقوف", "Cannot post to a group or inactive account"],
  [/period is closed/i, "الفترة المالية مقفلة", "The fiscal period is closed"],
  [/immutable|cannot change|cannot be deleted/i, "لا يمكن تعديل مستند مُصدر أو مُرحّل — استخدم إشعاراً دائناً أو قيداً عكسياً", "Issued/posted documents cannot be changed — use a credit note or a reversing entry"],
  [/pending ZATCA/i, "الفاتورة السابقة لم تكتمل معالجتها لدى ZATCA — افتحها وأعد المعالجة", "The previous invoice is still pending ZATCA processing — open it and retry"],
  [/customer VAT number/i, "الفاتورة الضريبية (B2B) تتطلب الرقم الضريبي للعميل", "A standard invoice needs the customer's VAT number"],
  [/national address/i, "الفاتورة الضريبية تتطلب العنوان الوطني الكامل للعميل", "A standard invoice needs the customer's full national address"],
  [/requires a customer/i, "اختر العميل", "Select a customer"],
  [/exceeds the remaining value/i, "قيمة الإشعار الدائن تتجاوز المتبقي من الفاتورة الأصلية", "Credit note exceeds the remaining invoice value"],
  [/exceeds (invoice|bill) balance/i, "المبلغ أكبر من الرصيد المتبقي", "Amount exceeds the outstanding balance"],
  [/permission denied/i, "ليست لديك صلاحية لهذا الإجراء", "You don't have permission for this action"],
  [/row-level security/i, "ليست لديك صلاحية لهذا الإجراء", "You don't have permission for this action"],
  [/no active organization/i, "اختر الشركة أولاً", "Select a company first"],
  [/duplicate key/i, "القيمة مستخدمة مسبقاً (رمز مكرر)", "This value is already used (duplicate code)"],
  [/vat_format/i, "الرقم الضريبي غير صحيح — 15 رقماً يبدأ وينتهي بـ 3", "Invalid VAT number — 15 digits starting and ending with 3"],
  [/iban/i, "رقم الآيبان غير صحيح — SA متبوعاً بـ 22 رقماً", "Invalid IBAN — SA followed by 22 digits"],
  [/not-null constraint/i, "يوجد حقل مطلوب فارغ — أكمل البيانات", "A required field is empty"],
  [/already exists/i, "موجود مسبقاً", "Already exists"],
  [/net salary cannot be negative/i, "صافي الراتب لا يمكن أن يكون سالباً", "Net salary cannot be negative"],
  [/exceeds the contract/i, "الكمية التراكمية تتجاوز كمية العقد", "Cumulative quantity exceeds the contract quantity"],
  [/nothing to bill/i, "لا توجد أعمال جديدة لفوترتها في هذا المستخلص", "Nothing new to bill in this period"],
];

export function friendlyError(err, lang = "ar") {
  const msg = err?.message || String(err || "");
  for (const [re, ar, en] of RULES) if (re.test(msg)) return lang === "ar" ? ar : en;
  return msg || (lang === "ar" ? "حدث خطأ غير متوقع" : "Unexpected error");
}
