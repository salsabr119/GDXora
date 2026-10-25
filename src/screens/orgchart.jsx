// Organisation chart: people by direct manager, or organisation units (any
// depth) by parent unit. With hr.manage the chart is also the editor: click a
// person or a unit to move it, make someone a head, or add a person / sub-unit
// underneath; "Managers from units" derives direct managers from unit heads.
import { useMemo, useState } from "react";
import { supabase, run, rpc } from "../supabase.js";
import { useApp, useData, useAction, PageHead, Panel, Tabs, Loading, Modal, Field, Select, Issues, useIssues, confirmDialog } from "../ui.jsx";
import { today } from "../lib/format.js";
import { UNIT_TYPES } from "./hr.jsx";

const fullName = (e) => `${e.first_name_ar} ${e.last_name_ar}`;

/** parent → children index; roots are rows whose parent is missing or unknown */
function index(rows, parentKey) {
  const ids = new Set(rows.map((r) => r.id));
  const kids = new Map();
  const roots = [];
  for (const r of rows) {
    const p = r[parentKey];
    if (p && ids.has(p)) { if (!kids.has(p)) kids.set(p, []); kids.get(p).push(r); }
    else roots.push(r);
  }
  return { kids, roots };
}
const countAll = (id, kids) => (kids.get(id) || []).reduce((n, c) => n + 1 + countAll(c.id, kids), 0);
const below = (id, kids, out = new Set()) => { for (const c of kids.get(id) || []) { out.add(c.id); below(c.id, kids, out); } return out; };
// a sensible default type for a sub-unit
const nextType = (type) => ({ sector: "general_department", general_department: "department", department: "section", section: "unit", unit: "unit" }[type] || "department");

export function OrgChart() {
  const { t, can } = useApp();
  const edit = can("hr.manage");
  const [act, busy] = useAction();
  const iss = useIssues();
  const [view, setView] = useState("people");
  const [base, setBase] = useState("top");          // top: first levels open · all · none
  const [over, setOver] = useState(() => new Map());  // per-node overrides of the base
  const [q, setQ] = useState("");
  const [panel, setPanel] = useState(null);          // { kind: person|newPerson|unit|newUnit|assign, ... }
  const types = UNIT_TYPES(t);
  const d = useData(async () => ({
    emps: await run(supabase.from("employees").select("id, code, first_name_ar, last_name_ar, job_title, manager_id, department_id, status")
      .neq("status", "terminated").order("code")),
    units: await run(supabase.from("departments").select("id, name_ar, name_en, code, unit_type, parent_id, head_employee_id").order("name_ar")),
  }), []);

  const people = useMemo(() => (d.data ? index(d.data.emps, "manager_id") : null), [d.data]);
  const unitTree = useMemo(() => (d.data ? index(d.data.units, "parent_id") : null), [d.data]);
  if (!d.data) return <Loading />;
  const { emps, units } = d.data;
  const byId = Object.fromEntries(emps.map((e) => [e.id, e]));
  const unitById = Object.fromEntries(units.map((u) => [u.id, u]));
  const typeLabel = (u) => types.find((x) => x.id === u.unit_type)?.label || "";

  const isOpen = (id, depth, top = 1) => (over.has(id) ? over.get(id) : base === "all" ? true : base === "none" ? false : depth < top);
  const toggle = (id, depth, top) => setOver((m) => new Map(m).set(id, !isOpen(id, depth, top)));
  const setAll = (b) => { setBase(b); setOver(new Map()); };
  const match = q.trim() ? emps.filter((e) => `${fullName(e)} ${e.code} ${e.job_title || ""}`.includes(q.trim())) : [];
  const hit = new Set(match.map((e) => e.id));
  const onPath = new Set();
  for (const e of match) { let m = byId[e.manager_id]; while (m && !onPath.has(m.id)) { onPath.add(m.id); m = byId[m.manager_id]; } }
  const staff = (unitId) => emps.filter((e) => e.department_id === unitId);
  const staffAll = (unitId) => staff(unitId).length + (unitTree.kids.get(unitId) || []).reduce((n, c) => n + staffAll(c.id), 0);
  const empOpts = (exclude = new Set()) => emps.filter((e) => !exclude.has(e.id)).map((e) => ({ id: e.id, label: `${e.code} — ${fullName(e)}${e.job_title ? ` (${e.job_title})` : ""}` }));
  const unitOpts = (exclude = new Set()) => units.filter((u) => !exclude.has(u.id)).map((u) => ({ id: u.id, label: `${typeLabel(u)}: ${u.name_ar}` }));
  const close = () => { setPanel(null); iss.clear(); };
  const done = (ok) => { if (ok) { close(); d.reload(); } };

  /* ── save actions ── */
  async function savePerson() {
    const p = panel;
    const isHead = !!p.department_id && unitById[p.department_id]?.head_employee_id === p.id;
    const ok = await act(async () => {
      await rpc("save_employees", { p_rows: [{ id: p.id, manager_id: p.manager_id || null, department_id: p.department_id || null }] });
      if (p.makeHead !== undefined && p.makeHead !== isHead && p.department_id) {
        await rpc("save_departments", { p_rows: [{ id: p.department_id, head_employee_id: p.makeHead ? p.id : null }] });
      }
      return true;
    }, t(`تم تحديث موقع ${p.name} في الهيكل`, `${p.name}'s position updated`));
    done(ok);
  }
  async function addPerson() {
    const p = panel;
    if (!iss.check([
      !String(p.first_name_ar || "").trim() && { key: "first_name_ar", msg: t("اكتب الاسم الأول", "Enter the first name") },
      !String(p.last_name_ar || "").trim() && { key: "last_name_ar", msg: t("اكتب اسم العائلة", "Enter the last name") },
      !/^[A-Za-z]{2}$/.test(p.nationality || "") && { key: "nationality", msg: t("رمز الجنسية حرفان (مثال: SA، EG، IN)", "Nationality is a 2-letter code") },
      !p.hire_date && { key: "hire_date", msg: t("أدخل تاريخ المباشرة", "Enter the hire date") },
    ])) return;
    const ok = await act(() => rpc("save_employees", { p_rows: [{ first_name_ar: p.first_name_ar.trim(), last_name_ar: p.last_name_ar.trim(),
      nationality: p.nationality.toUpperCase(), hire_date: p.hire_date, job_title: p.job_title || null, manager_id: p.manager_id || null,
      department_id: p.department_id || null }] }).then(() => true),
      t(`تمت إضافة ${p.first_name_ar} ${p.last_name_ar}\nأكمل بقية بياناته (الهوية والراتب…) من شاشة الموظفين.`, "Employee added"));
    done(ok);
  }
  async function saveUnit() {
    const u = panel;
    if (!iss.check([!String(u.name_ar || "").trim() && { key: "name_ar", msg: t("اكتب اسم الوحدة", "Enter the unit name") }])) return;
    const rec = { name_ar: u.name_ar.trim(), name_en: u.name_en || null, unit_type: u.unit_type || "department", code: u.code || null,
                  parent_id: u.parent_id || null, head_employee_id: u.head_employee_id || null };
    const ok = await act(() => rpc("save_departments", { p_rows: [u.id ? { id: u.id, ...rec } : rec] }).then(() => true),
      u.id ? t(`تم تحديث «${rec.name_ar}»`, "Unit updated") : t(`تمت إضافة «${rec.name_ar}» إلى الهيكل`, "Unit added"));
    done(ok);
  }
  async function deleteUnit() {
    const u = panel;
    if ((unitTree.kids.get(u.id) || []).length || staff(u.id).length) {
      iss.check([t("لا يمكن حذف وحدة تحتها وحدات أو موظفون — انقلهم أولاً", "A unit with sub-units or staff can't be deleted — move them first")]); return;
    }
    if (!await confirmDialog(t(`حذف «${u.name_ar}» من الهيكل؟`, `Delete "${u.name_ar}"?`))) return;
    const ok = await act(async () => { await run(supabase.from("departments").delete().eq("id", u.id)); return true; }, t("تم حذف الوحدة", "Unit deleted"));
    done(ok);
  }
  async function assignManagers() {
    const n = await act(() => rpc("assign_managers_from_units", { p_overwrite: !!panel.overwrite }),
      t("تم تحديد المدراء المباشرين حسب رؤساء الوحدات", "Direct managers set from unit heads"));
    if (n !== undefined) { close(); d.reload(); }
  }

  /* ── nodes ── */
  const Person = ({ e, depth }) => {
    const kids = people.kids.get(e.id) || [];
    const shown = kids.length > 0 && (onPath.has(e.id) || isOpen(e.id, depth));
    const unit = unitById[e.department_id];
    const head = unit && unit.head_employee_id === e.id;
    return (
      <li>
        <div className={`org-node ${hit.has(e.id) ? "hit" : ""} ${edit ? "editable" : ""}`}
             onClick={edit ? () => { iss.clear(); setPanel({ kind: "person", id: e.id, name: fullName(e), manager_id: e.manager_id, department_id: e.department_id }); } : undefined}>
          <div className="org-name">{fullName(e)}</div>
          <div className="org-title">{e.job_title || "—"}</div>
          {unit && <div className="org-dept">{head ? "★ " : ""}{unit.name_ar}</div>}
          {kids.length > 0 && <button className="org-toggle" onClick={(ev) => { ev.stopPropagation(); toggle(e.id, depth); }}>
            {shown ? "−" : "+"} {kids.length}{countAll(e.id, people.kids) > kids.length ? ` / ${countAll(e.id, people.kids)}` : ""}</button>}
        </div>
        {shown && <ul>{kids.map((c) => <Person key={c.id} e={c} depth={depth + 1} />)}</ul>}
      </li>
    );
  };

  const Unit = ({ u, depth }) => {
    const kids = unitTree.kids.get(u.id) || [];
    const list = staff(u.id);
    // no head set: the unit's top person (whose manager is outside it), the one with the largest team
    const inferred = !u.head_employee_id && list.filter((e) => byId[e.manager_id]?.department_id !== u.id)
      .sort((a, b) => countAll(b.id, people.kids) - countAll(a.id, people.kids))[0];
    const head = byId[u.head_employee_id] || inferred;
    const shown = kids.length > 0 && isOpen(u.id, depth, 2);
    const membersOpen = !!over.get(`m:${u.id}`);
    return (
      <li>
        <div className={`org-node dept t-${u.unit_type} ${edit ? "editable" : ""}`}
             onClick={edit ? () => { iss.clear(); setPanel({ kind: "unit", ...u }); } : undefined}>
          <div className="org-type">{typeLabel(u)}{u.code ? ` · ${u.code}` : ""}</div>
          <div className="org-name">{u.name_ar}</div>
          <div className="org-title">{head ? `${t("الرئيس", "Head")}: ${fullName(head)}${inferred ? t(" (حسب الهيكل)", " (inferred)") : ""}` : t("بدون رئيس", "No head")}</div>
          <div className="row" style={{ gap: 4, justifyContent: "center", flexWrap: "wrap" }}>
            <button className="org-toggle" title={t("موظفو الوحدة / مع الوحدات التابعة", "Staff in unit / including sub-units")}
                    onClick={(ev) => { ev.stopPropagation(); setOver((m) => new Map(m).set(`m:${u.id}`, !membersOpen)); }}>
              👤 {list.length}{staffAll(u.id) > list.length ? ` / ${staffAll(u.id)}` : ""}</button>
            {kids.length > 0 && <button className="org-toggle" onClick={(ev) => { ev.stopPropagation(); toggle(u.id, depth, 2); }}>{shown ? "−" : "+"} {kids.length} {t("وحدة", "units")}</button>}
          </div>
          {membersOpen && list.length > 0 && <ul className="org-members">{list.map((e) => <li key={e.id}>{e.id === head?.id ? "★ " : ""}{fullName(e)} <span className="muted">— {e.job_title || ""}</span></li>)}</ul>}
        </div>
        {shown && <ul>{kids.map((c) => <Unit key={c.id} u={c} depth={depth + 1} />)}</ul>}
      </li>
    );
  };

  /* ── editor panels ── */
  let editor = null;
  if (panel?.kind === "person") {
    const p = panel;
    const unit = unitById[p.department_id];
    const isHead = !!unit && unit.head_employee_id === p.id;
    const exclude = new Set([p.id, ...below(p.id, people.kids)]);   // nobody can report to their own team
    editor = (
      <Modal title={t(`موقع ${p.name} في الهيكل`, `${p.name} in the chart`)} onClose={close}
             footer={<><button className="btn" onClick={() => setPanel({ kind: "newPerson", manager_id: p.id, department_id: p.department_id, nationality: "SA", hire_date: today(), underName: p.name })}>
               {t("+ موظف تحته", "+ Person below")}</button><span style={{ flex: 1 }} />
               <button className="btn" onClick={close}>{t("إلغاء", "Cancel")}</button><button className="btn primary" onClick={savePerson} disabled={busy}>{t("حفظ", "Save")}</button></>}>
        <Issues issues={iss.issues} />
        <div className="form">
          <Field label={t("المدير المباشر", "Direct manager")} wide hint={t("فريقه ينتقل معه تلقائياً", "Their team moves with them")}>
            <Select value={p.manager_id} onChange={(v) => setPanel({ ...p, manager_id: v })} options={empOpts(exclude)} placeholder={t("— بدون (أعلى الهيكل) —", "— None (top) —")} /></Field>
          <Field label={t("الوحدة التنظيمية", "Unit")} wide>
            <Select value={p.department_id} onChange={(v) => setPanel({ ...p, department_id: v, makeHead: undefined })} options={unitOpts()} /></Field>
          {p.department_id && <Field label="" wide><label className="row" style={{ gap: 8 }}>
            <input type="checkbox" checked={p.makeHead ?? isHead} onChange={(e) => setPanel({ ...p, makeHead: e.target.checked })} />
            {t(`رئيس «${unitById[p.department_id]?.name_ar}»`, `Head of "${unitById[p.department_id]?.name_ar}"`)}</label></Field>}
        </div>
      </Modal>);
  } else if (panel?.kind === "newPerson") {
    const p = panel;
    editor = (
      <Modal title={p.underName ? t(`موظف جديد — ${p.underName}`, `New person — ${p.underName}`) : t("موظف جديد", "New person")} onClose={close}
             footer={<><span style={{ flex: 1 }} /><button className="btn" onClick={close}>{t("إلغاء", "Cancel")}</button>
               <button className="btn primary" onClick={addPerson} disabled={busy}>{t("إضافة", "Add")}</button></>}>
        <Issues issues={iss.issues} />
        <div className="form">
          <Field label={t("الاسم الأول", "First name")} required invalid={iss.has("first_name_ar")}><input value={p.first_name_ar || ""} onChange={(e) => setPanel({ ...p, first_name_ar: e.target.value })} /></Field>
          <Field label={t("اسم العائلة", "Last name")} required invalid={iss.has("last_name_ar")}><input value={p.last_name_ar || ""} onChange={(e) => setPanel({ ...p, last_name_ar: e.target.value })} /></Field>
          <Field label={t("المسمى الوظيفي", "Job title")}><input value={p.job_title || ""} onChange={(e) => setPanel({ ...p, job_title: e.target.value })} /></Field>
          <Field label={t("رمز الجنسية", "Nationality")} required invalid={iss.has("nationality")}><input dir="ltr" maxLength={2} value={p.nationality || ""} onChange={(e) => setPanel({ ...p, nationality: e.target.value.toUpperCase() })} /></Field>
          <Field label={t("تاريخ المباشرة", "Hire date")} required invalid={iss.has("hire_date")}><input type="date" value={p.hire_date || ""} onChange={(e) => setPanel({ ...p, hire_date: e.target.value })} /></Field>
          <Field label={t("الوحدة التنظيمية", "Unit")}><Select value={p.department_id} onChange={(v) => setPanel({ ...p, department_id: v })} options={unitOpts()} /></Field>
          <Field label={t("المدير المباشر", "Direct manager")} wide><Select value={p.manager_id} onChange={(v) => setPanel({ ...p, manager_id: v })} options={empOpts()} /></Field>
        </div>
      </Modal>);
  } else if (panel?.kind === "unit" || panel?.kind === "newUnit") {
    const u = panel;
    const isNew = panel.kind === "newUnit";
    const exclude = isNew ? new Set() : new Set([u.id, ...below(u.id, unitTree.kids)]);
    editor = (
      <Modal title={isNew ? (u.underName ? t(`وحدة جديدة تحت «${u.underName}»`, `New unit under "${u.underName}"`) : t("وحدة تنظيمية جديدة", "New unit")) : u.name_ar} onClose={close} wide
             footer={<>{!isNew && <><button className="btn danger" onClick={deleteUnit} disabled={busy}>{t("حذف", "Delete")}</button>
                 <button className="btn" onClick={() => setPanel({ kind: "newUnit", parent_id: u.id, underName: u.name_ar, unit_type: nextType(u.unit_type) })}>{t("+ وحدة فرعية", "+ Sub-unit")}</button>
                 <button className="btn" onClick={() => setPanel({ kind: "newPerson", department_id: u.id, manager_id: u.head_employee_id, nationality: "SA", hire_date: today(), underName: u.name_ar })}>{t("+ موظف فيها", "+ Person")}</button></>}
               <span style={{ flex: 1 }} /><button className="btn" onClick={close}>{t("إلغاء", "Cancel")}</button>
               <button className="btn primary" onClick={saveUnit} disabled={busy}>{isNew ? t("إضافة", "Add") : t("حفظ", "Save")}</button></>}>
        <Issues issues={iss.issues} />
        <div className="form">
          <Field label={t("اسم الوحدة", "Name")} required invalid={iss.has("name_ar")}><input value={u.name_ar || ""} onChange={(e) => setPanel({ ...u, name_ar: e.target.value })} /></Field>
          <Field label={t("النوع", "Type")}><Select value={u.unit_type || "department"} onChange={(v) => setPanel({ ...u, unit_type: v || "department" })} options={types} /></Field>
          <Field label={t("الاسم بالإنجليزي", "English name")}><input dir="ltr" value={u.name_en || ""} onChange={(e) => setPanel({ ...u, name_en: e.target.value })} /></Field>
          <Field label={t("الرمز (اختياري)", "Code (optional)")}><input dir="ltr" value={u.code || ""} onChange={(e) => setPanel({ ...u, code: e.target.value })} /></Field>
          <Field label={t("تتبع وحدة", "Under unit")} wide><Select value={u.parent_id} onChange={(v) => setPanel({ ...u, parent_id: v })} options={unitOpts(exclude)} placeholder={t("— أعلى الهيكل —", "— Top level —")} /></Field>
          <Field label={t("رئيس الوحدة", "Head")} wide><Select value={u.head_employee_id} onChange={(v) => setPanel({ ...u, head_employee_id: v })} options={empOpts()} /></Field>
        </div>
      </Modal>);
  } else if (panel?.kind === "assign") {
    editor = (
      <Modal title={t("تحديد المدراء المباشرين حسب الوحدات", "Direct managers from units")} onClose={close}
             footer={<><span style={{ flex: 1 }} /><button className="btn" onClick={close}>{t("إلغاء", "Cancel")}</button>
               <button className="btn primary" onClick={assignManagers} disabled={busy}>{t("تنفيذ", "Run")}</button></>}>
        <p className="confirm-msg">{t("كل موظف يصبح مديره المباشر رئيسَ وحدته، ورئيس الوحدة يصبح مديره رئيسَ الوحدة الأعلى (وإن لم يكن لها رئيس فالتي فوقها).",
          "Each employee reports to the head of their unit; a unit head reports to the nearest head above.")}</p>
        <label className="row" style={{ gap: 8, marginTop: 12 }}><input type="checkbox" checked={!!panel.overwrite} onChange={(e) => setPanel({ ...panel, overwrite: e.target.checked })} />
          {t("استبدال المدراء الحاليين أيضاً (وليس فقط من ليس له مدير)", "Also replace existing managers (not only those without one)")}</label>
      </Modal>);
  }

  const noManager = people.roots.length > 1 ? people.roots : [];
  const noUnit = emps.filter((e) => !e.department_id);
  return (
    <>
      <PageHead title={t("الهيكل الوظيفي", "Organisation chart")}
                sub={edit ? t("اضغط على أي موظف أو وحدة لتعديل موقعه أو إضافة ما تحته", "Click a person or unit to move it or add underneath")
                          : t("يُبنى من «المدير المباشر» لكل موظف ومن الوحدات التنظيمية", "Built from direct managers and organisation units")}>
        <input style={{ width: 180 }} placeholder={t("ابحث عن موظف…", "Find an employee…")} value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn" onClick={() => setAll("all")}>{t("توسيع الكل", "Expand all")}</button>
        <button className="btn" onClick={() => setAll("none")}>{t("طي الكل", "Collapse all")}</button>
        <button className="btn" onClick={() => window.print()}>🖨 {t("طباعة", "Print")}</button>
      </PageHead>
      {edit && <div className="row no-print" style={{ gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <button className="btn" onClick={() => { iss.clear(); setPanel({ kind: "newUnit", unit_type: "sector" }); }}>{t("+ وحدة تنظيمية", "+ Unit")}</button>
        <button className="btn" onClick={() => { iss.clear(); setPanel({ kind: "newPerson", nationality: "SA", hire_date: today() }); }}>{t("+ موظف", "+ Person")}</button>
        <button className="btn" onClick={() => setPanel({ kind: "assign" })}>{t("⇅ تحديد المدراء حسب الوحدات", "⇅ Managers from units")}</button>
        <span className="muted" style={{ fontSize: 12 }}>{t("للتعديل الجماعي: «الموظفون» أو «الوحدات التنظيمية» ← استيراد Excel ← تنزيل البيانات الحالية للتعديل", "Bulk edit: Employees or Units → Import Excel → Download current data")}</span>
      </div>}
      <Tabs value={view} onChange={setView} tabs={[["people", t("حسب المدراء", "By manager")], ["units", t("حسب الوحدات التنظيمية", "By unit")]]} />
      {view === "people" && noManager.length > 0 && (
        <div className="alert warn no-print">{t(`${noManager.length} موظفين بدون مدير مباشر (يظهرون في أعلى الهيكل): `, `${noManager.length} employees have no direct manager (shown at the top): `)}
          {noManager.slice(0, 8).map(fullName).join("، ")}{noManager.length > 8 ? "…" : ""}</div>)}
      {view === "units" && noUnit.length > 0 && <div className="alert warn no-print">{t(`${noUnit.length} موظفين بدون وحدة تنظيمية`, `${noUnit.length} employees have no unit`)}</div>}
      {q.trim() && <div className="muted no-print" style={{ marginBottom: 8 }}>{match.length ? t(`${match.length} نتيجة — مظللة في الهيكل`, `${match.length} found — highlighted`) : t("لا توجد نتائج", "No match")}</div>}
      <Panel pad={false}>
        <div className="org">
          {view === "people"
            ? (emps.length ? <ul>{people.roots.map((e) => <Person key={e.id} e={e} depth={0} />)}</ul> : <div className="empty">{t("لا يوجد موظفون بعد", "No employees yet")}</div>)
            : (units.length ? <ul>{unitTree.roots.map((u) => <Unit key={u.id} u={u} depth={0} />)}</ul> : <div className="empty">{t("لا توجد وحدات بعد — ابدأ بـ «+ وحدة تنظيمية»", "No units yet — start with “+ Unit”")}</div>)}
        </div>
      </Panel>
      {editor}
    </>
  );
}
