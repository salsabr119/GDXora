// Organisation chart: people by direct manager, or departments by parent
// department. Built from employees.manager_id and departments.parent_id /
// head_employee_id; change those on the employee / department forms.
import { useMemo, useState } from "react";
import { supabase, run } from "../supabase.js";
import { useApp, useData, PageHead, Panel, Tabs, Loading } from "../ui.jsx";

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

export function OrgChart() {
  const { t } = useApp();
  const [view, setView] = useState("people");
  const [base, setBase] = useState("top");          // top: first two levels open · all · none
  const [over, setOver] = useState(() => new Map());  // per-node overrides of the base
  const [q, setQ] = useState("");
  const d = useData(async () => ({
    emps: await run(supabase.from("employees").select("id, code, first_name_ar, last_name_ar, job_title, manager_id, department_id, status, departments(name_ar)")
      .neq("status", "terminated").order("code")),
    depts: await run(supabase.from("departments").select("id, name_ar, parent_id, head_employee_id").order("name_ar")),
  }), []);

  const people = useMemo(() => (d.data ? index(d.data.emps, "manager_id") : null), [d.data]);
  const deptTree = useMemo(() => (d.data ? index(d.data.depts, "parent_id") : null), [d.data]);
  if (!d.data) return <Loading />;
  const { emps, depts } = d.data;
  const byId = Object.fromEntries(emps.map((e) => [e.id, e]));

  // the chart opens on the top two levels; a search opens the path to the match
  const isOpen = (id, depth) => (over.has(id) ? over.get(id) : base === "all" ? true : base === "none" ? false : depth < 1);
  const toggle = (id, depth) => setOver((m) => new Map(m).set(id, !isOpen(id, depth)));
  const setAll = (b) => { setBase(b); setOver(new Map()); };
  const match = q.trim() ? emps.filter((e) => `${fullName(e)} ${e.code} ${e.job_title || ""}`.includes(q.trim())) : [];
  const hit = new Set(match.map((e) => e.id));
  const onPath = new Set();
  for (const e of match) { let m = byId[e.manager_id]; while (m && !onPath.has(m.id)) { onPath.add(m.id); m = byId[m.manager_id]; } }

  const Person = ({ e, depth }) => {
    const kids = people.kids.get(e.id) || [];
    const shown = kids.length > 0 && (onPath.has(e.id) || isOpen(e.id, depth));
    return (
      <li>
        <div className={`org-node ${hit.has(e.id) ? "hit" : ""}`}>
          <div className="org-name">{fullName(e)}</div>
          <div className="org-title">{e.job_title || "—"}</div>
          {e.departments?.name_ar && <div className="org-dept">{e.departments.name_ar}</div>}
          {kids.length > 0 && <button className="org-toggle" onClick={() => toggle(e.id, depth)}>
            {shown ? "−" : "+"} {kids.length}{countAll(e.id, people.kids) > kids.length ? ` / ${countAll(e.id, people.kids)}` : ""}</button>}
        </div>
        {shown && <ul>{kids.map((c) => <Person key={c.id} e={c} depth={depth + 1} />)}</ul>}
      </li>
    );
  };

  const members = (deptId) => emps.filter((e) => e.department_id === deptId);
  const Dept = ({ x, depth }) => {
    const kids = deptTree.kids.get(x.id) || [];
    const list = members(x.id);
    // no head set: the department's top person (whose manager is outside it), the one with the largest team
    const inferred = !x.head_employee_id && list.filter((e) => byId[e.manager_id]?.department_id !== x.id)
      .sort((a, b) => countAll(b.id, people.kids) - countAll(a.id, people.kids))[0];
    const head = byId[x.head_employee_id] || inferred;
    const shown = isOpen(x.id, depth);
    return (
      <li>
        <div className="org-node dept">
          <div className="org-name">{x.name_ar}</div>
          <div className="org-title">{head ? `${t("الرئيس", "Head")}: ${fullName(head)}${inferred ? t(" (حسب الهيكل)", " (from the chart)") : ""}` : t("بدون رئيس قسم", "No head")}</div>
          <button className="org-toggle" onClick={() => toggle(x.id, depth)}>{shown ? "−" : "+"} {list.length} {t("موظف", "staff")}</button>
          {shown && list.length > 0 && <ul className="org-members">{list.map((e) => <li key={e.id}>{fullName(e)} <span className="muted">— {e.job_title || ""}</span></li>)}</ul>}
        </div>
        {kids.length > 0 && <ul>{kids.map((c) => <Dept key={c.id} x={c} depth={depth + 1} />)}</ul>}
      </li>
    );
  };

  const noManager = people.roots.length > 1 ? people.roots : [];
  const noDept = emps.filter((e) => !e.department_id);
  return (
    <>
      <PageHead title={t("الهيكل الوظيفي", "Organisation chart")}
                sub={t("يُبنى من «المدير المباشر» في ملف كل موظف، ومن «يتبع قسم» و«رئيس القسم» في الأقسام", "Built from each employee's direct manager and each department's parent and head")}>
        <input style={{ width: 200 }} placeholder={t("ابحث عن موظف…", "Find an employee…")} value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn" onClick={() => setAll("all")}>{t("توسيع الكل", "Expand all")}</button>
        <button className="btn" onClick={() => setAll("none")}>{t("طي الكل", "Collapse all")}</button>
        <button className="btn" onClick={() => window.print()}>🖨 {t("طباعة", "Print")}</button>
      </PageHead>
      <Tabs value={view} onChange={setView} tabs={[["people", t("حسب المدراء", "By manager")], ["depts", t("حسب الأقسام", "By department")]]} />
      {view === "people" && noManager.length > 0 && (
        <div className="alert warn no-print">{t(`${noManager.length} موظفين بدون مدير مباشر (يظهرون في أعلى الهيكل): `, `${noManager.length} employees have no direct manager (shown at the top): `)}
          {noManager.slice(0, 8).map(fullName).join("، ")}{noManager.length > 8 ? "…" : ""}</div>)}
      {view === "depts" && noDept.length > 0 && <div className="alert warn no-print">{t(`${noDept.length} موظفين بدون قسم`, `${noDept.length} employees have no department`)}</div>}
      {q.trim() && <div className="muted no-print" style={{ marginBottom: 8 }}>{match.length ? t(`${match.length} نتيجة — مظللة في الهيكل`, `${match.length} found — highlighted`) : t("لا توجد نتائج", "No match")}</div>}
      <Panel pad={false}>
        <div className="org">
          {view === "people"
            ? (emps.length ? <ul>{people.roots.map((e) => <Person key={e.id} e={e} depth={0} />)}</ul> : <div className="empty">{t("لا يوجد موظفون بعد", "No employees yet")}</div>)
            : (depts.length ? <ul>{deptTree.roots.map((x) => <Dept key={x.id} x={x} depth={0} />)}</ul> : <div className="empty">{t("لا توجد أقسام بعد", "No departments yet")}</div>)}
        </div>
      </Panel>
    </>
  );
}
