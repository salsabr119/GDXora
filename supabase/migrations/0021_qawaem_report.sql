-- GDXora · 0021 — report_qawaem(year): every figure the Qawaem platform asks
-- for, keyed by the platform's own line numbers, plus the checks to run
-- before filing.
--  • figures are whole riyals; each line is rounded and the totals are sums of
--    the rounded lines. A balance-sheet rounding difference goes to retained
--    earnings (line 26) and is reported as a check, so every statement agrees
--  • there is no year-end closing entry yet: retained earnings (line 26) are
--    the retained-earnings accounts plus all profit or loss not closed
--  • the cash-flow statement (indirect method) is derived from the change in
--    each balance-sheet line between the two year ends, so it always ends at
--    the cash on the balance sheet
--  • lines 16, 22 and 23 of the cash flow are given as positive amounts: the
--    platform subtracts them
--  • the fiscal year is the calendar year

-- amount of each Qawaem line: balance-sheet lines at p_to, profit-or-loss
-- lines for p_from..p_to; line 26 also carries the unclosed profit to p_to
create or replace function _qawaem_lines(p_org uuid, p_from date, p_to date)
returns table (statement text, line_no int, amount numeric)
language sql stable security definer set search_path = public as $$
  with acc as (
    select a.id, coalesce(m.statement, d.statement) as st, coalesce(m.line_no, d.line_no) as ln, coalesce(m.sign, 1) as sg
      from accounts a
      left join qawaem_line_map m on m.account_id = a.id
      cross join lateral qawaem_default_line(a.system_key, a.code, a.type) d
     where a.org_id = p_org and not a.is_group),
  bal as (
    select l.account_id,
           sum(l.debit - l.credit) as to_date,
           sum(case when e.entry_date >= p_from then l.debit - l.credit else 0 end) as in_period
      from journal_lines l join journal_entries e on e.id = l.entry_id
     where e.org_id = p_org and e.status in ('posted','reversed') and e.entry_date <= p_to
     group by l.account_id)
  select acc.st, acc.ln,
         sum(acc.sg * case when acc.st = 'BS' and acc.ln < 13 then coalesce(b.to_date, 0)
                           when acc.st = 'BS' then -coalesce(b.to_date, 0)
                           when acc.ln in (2,3,6,7,8,9) then -coalesce(b.in_period, 0)
                           else coalesce(b.in_period, 0) end)
    from acc left join bal b on b.account_id = acc.id
   group by acc.st, acc.ln
  union all
  select 'BS', 26, coalesce(sum(-b.to_date), 0)
    from acc join bal b on b.account_id = acc.id
   where acc.st = 'PL'
$$;
revoke execute on function _qawaem_lines(uuid, date, date) from public, anon, authenticated;

-- the balance sheet at one date, rounded: {"2": …, "13": …, …, "32": …}
create or replace function _qawaem_bs(p_org uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v jsonb := '{}'::jsonb; raw jsonb; n int; adj numeric;
  a numeric; l numeric; e numeric;
begin
  select coalesce(jsonb_object_agg(q.line_no::text, q.amt), '{}'::jsonb) into raw
    from (select line_no, sum(amount) as amt from _qawaem_lines(p_org, p_from, p_to) where statement = 'BS' group by line_no) q;
  foreach n in array array[2,3,4,5,6,7,8,9,10,11,12,16,17,18,19,20,21,22,25,26,27,28,30] loop
    v := v || jsonb_build_object(n::text, round(coalesce((raw ->> n::text)::numeric, 0)));
  end loop;
  a := (select sum((v ->> k::text)::numeric) from unnest(array[2,3,4,5,6,7,8,9,10,11,12]) k);
  l := (select sum((v ->> k::text)::numeric) from unnest(array[16,17,18,19,20,21,22]) k);
  e := (select sum((v ->> k::text)::numeric) from unnest(array[25,26,27,28,30]) k);
  adj := a - l - e;
  v := v || jsonb_build_object('26', (v ->> '26')::numeric + adj);
  e := e + adj;
  return v || jsonb_build_object(
    '13', a, '23', l,
    '29', (v ->> '25')::numeric + (v ->> '26')::numeric + (v ->> '27')::numeric + (v ->> '28')::numeric,
    '31', e, '32', l + e, '_rounding', adj);
end $$;
revoke execute on function _qawaem_bs(uuid, date, date) from public, anon, authenticated;

create or replace function report_qawaem(p_year int)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_org uuid := require_perm('accounting.view');
  v_from date := make_date(p_year, 1, 1); v_to date := make_date(p_year, 12, 31);
  bs jsonb; bs0 jsonb; pl jsonb := '{}'::jsonb; cf jsonb; soce jsonb; checks jsonb := '[]'::jsonb;
  n int; raw jsonb; profit numeric; dep numeric; v_first boolean; v_emp int; v_capital numeric;
  unb_a numeric; unb_le numeric;
  d jsonb := '{}'::jsonb;   -- change in each balance-sheet line over the year
  ppe numeric; inv numeric; cap numeric; loans numeric; eq_other numeric;
begin
  if p_year not between 2000 and 2100 then raise exception 'invalid year'; end if;

  bs  := _qawaem_bs(v_org, v_from, v_to);
  bs0 := _qawaem_bs(v_org, v_from - 365 * 100, v_from - 1);
  foreach n in array array[2,3,4,5,6,7,8,9,10,11,12,16,17,18,19,20,21,22,25,26,27,28,30] loop
    d := d || jsonb_build_object(n::text, (bs ->> n::text)::numeric - (bs0 ->> n::text)::numeric);
  end loop;

  -- profit or loss
  select coalesce(jsonb_object_agg(q.line_no::text, q.amt), '{}'::jsonb) into raw
    from (select line_no, sum(amount) as amt from _qawaem_lines(v_org, v_from, v_to) where statement = 'PL' group by line_no) q;
  foreach n in array array[2,3,4,6,7,8,9,12,13,14,15,18,19] loop
    pl := pl || jsonb_build_object(n::text, round(coalesce((raw ->> n::text)::numeric, 0)));
  end loop;
  profit := (pl->>'2')::numeric + (pl->>'3')::numeric - (pl->>'4')::numeric + (pl->>'6')::numeric + (pl->>'7')::numeric
          + (pl->>'8')::numeric + (pl->>'9')::numeric - (pl->>'12')::numeric - (pl->>'13')::numeric - (pl->>'14')::numeric
          - (pl->>'15')::numeric - (pl->>'18')::numeric - (pl->>'19')::numeric;
  pl := pl || jsonb_build_object('22', 0, '23', profit);

  -- cash flow, indirect method
  select round(coalesce(sum(l.debit - l.credit), 0)) into dep
    from journal_lines l join journal_entries e on e.id = l.entry_id join accounts a on a.id = l.account_id
   where e.org_id = v_org and e.status in ('posted','reversed') and e.entry_date between v_from and v_to
     and a.system_key = 'depreciation';
  ppe := (d->>'7')::numeric + (d->>'8')::numeric + (d->>'9')::numeric + dep;          -- additions before depreciation
  inv := (d->>'6')::numeric + (d->>'10')::numeric;
  cap := (d->>'25')::numeric; loans := (d->>'16')::numeric;
  eq_other := (d->>'26')::numeric - profit + (d->>'27')::numeric + (d->>'28')::numeric + (d->>'30')::numeric;
  cf := jsonb_build_object(
    'profit', profit,
    '4', dep, '5', 0, '6', 0, '7', 0,
    '8', (d->>'18')::numeric + (d->>'21')::numeric + (d->>'22')::numeric,           -- non-cash: zakat accrued, EOSB, deferred tax
    '10', -((d->>'3')::numeric + (d->>'4')::numeric + (d->>'11')::numeric + (d->>'12')::numeric),
    '11', -(d->>'5')::numeric,
    '12', (d->>'17')::numeric + (d->>'19')::numeric + (d->>'20')::numeric,
    '15', greatest(-ppe, 0), '16', greatest(ppe, 0), '17', -inv,
    '20', greatest(cap, 0), '21', greatest(loans, 0), '22', greatest(-loans, 0), '23', 0,
    '24', eq_other + least(cap, 0),
    '27', (bs0->>'2')::numeric);
  cf := cf || jsonb_build_object(
    'operating', profit + (cf->>'4')::numeric + (cf->>'8')::numeric + (cf->>'10')::numeric + (cf->>'11')::numeric + (cf->>'12')::numeric,
    'investing', (cf->>'15')::numeric - (cf->>'16')::numeric + (cf->>'17')::numeric,
    'financing', (cf->>'20')::numeric + (cf->>'21')::numeric - (cf->>'22')::numeric - (cf->>'23')::numeric + (cf->>'24')::numeric);
  cf := cf || jsonb_build_object('28', (cf->>'27')::numeric + (cf->>'operating')::numeric + (cf->>'investing')::numeric + (cf->>'financing')::numeric);

  -- changes in equity: rows 1, 4, 5, 7, 8, 9, 11 × capital, retained, statutory, other, parent, nci, total
  soce := jsonb_build_object(
    '1',  _qawaem_soce_row((bs0->>'25')::numeric, (bs0->>'26')::numeric, (bs0->>'27')::numeric, (bs0->>'28')::numeric, (bs0->>'30')::numeric),
    '4',  _qawaem_soce_row(0, profit, 0, 0, 0),
    '5',  _qawaem_soce_row(0, 0, 0, 0, 0),
    '7',  _qawaem_soce_row(0, -(d->>'27')::numeric, (d->>'27')::numeric, 0, 0),
    '8',  _qawaem_soce_row(0, 0, 0, 0, 0),
    '9',  _qawaem_soce_row((d->>'25')::numeric, (d->>'26')::numeric - profit + (d->>'27')::numeric, 0, (d->>'28')::numeric, (d->>'30')::numeric),
    '11', _qawaem_soce_row((bs->>'25')::numeric, (bs->>'26')::numeric, (bs->>'27')::numeric, (bs->>'28')::numeric, (bs->>'30')::numeric));

  -- before-filing checks (unrounded balance first: the ledger itself must balance)
  select coalesce(sum(amount) filter (where line_no < 13), 0), coalesce(sum(amount) filter (where line_no > 13), 0)
    into unb_a, unb_le from _qawaem_lines(v_org, v_from, v_to) where statement = 'BS';
  select coalesce(sum(l.credit - l.debit), 0) into v_capital
    from journal_lines l join journal_entries e on e.id = l.entry_id join accounts a on a.id = l.account_id
   where e.org_id = v_org and e.status in ('posted','reversed') and e.entry_date <= v_to and a.system_key = 'capital';
  if v_capital = 0 then v_capital := (bs->>'25')::numeric; end if;

  checks := jsonb_build_array(
    _qawaem_check('balance', unb_a = unb_le, 'error',
      'الموجودات = المطلوبات + حقوق الملكية', 'Assets = liabilities + equity',
      jsonb_build_object('assets', unb_a, 'liabilities_equity', unb_le)),
    _qawaem_check('landing_assets', (bs->>'13')::numeric = (bs->>'32')::numeric, 'error',
      'مجموع الموجودات في صفحة البداية = خانة 13 في الميزانية', 'Landing-page total assets = balance sheet line 13',
      jsonb_build_object('line_13', bs->'13', 'line_32', bs->'32')),
    _qawaem_check('cash', (cf->>'28')::numeric = (bs->>'2')::numeric, 'error',
      'النقد نهاية الفترة في التدفقات = النقد في الميزانية', 'Closing cash in the cash flow = cash on the balance sheet',
      jsonb_build_object('cash_flow', cf->'28', 'balance_sheet', bs->'2')),
    _qawaem_check('equity_columns',
      (soce->'11'->>'capital')::numeric = (bs->>'25')::numeric and (soce->'11'->>'retained')::numeric = (bs->>'26')::numeric
      and (soce->'11'->>'statutory')::numeric = (bs->>'27')::numeric and (soce->'11'->>'other')::numeric = (bs->>'28')::numeric
      and (soce->'11'->>'nci')::numeric = (bs->>'30')::numeric and (soce->'11'->>'total')::numeric = (bs->>'31')::numeric, 'error',
      'رصيد نهاية الفترة في التغير بحقوق الملكية = حقوق الملكية في الميزانية', 'Closing equity by column = balance sheet equity', null),
    _qawaem_check('profit', (pl->>'23')::numeric = profit and (cf->>'profit')::numeric = profit
      and (soce->'4'->>'retained')::numeric = profit, 'error',
      'صافي الربح نفسه في كل القوائم', 'Net profit agrees across the statements', jsonb_build_object('profit', profit)),
    _qawaem_check('half_capital', not ((bs->>'26')::numeric < 0 and -(bs->>'26')::numeric > v_capital / 2), 'warning',
      'الخسائر المتراكمة تجاوزت نصف رأس المال — يلزم إجراء حسب نظام الشركات', 'Accumulated losses exceed half the capital (Companies Law)',
      jsonb_build_object('losses', -(bs->>'26')::numeric, 'capital', v_capital)),
    _qawaem_check('negative_equity', (bs->>'31')::numeric >= 0, 'warning',
      'حقوق الملكية سالبة — أضف إيضاح «الاستمرارية»', 'Equity is negative — add a going-concern note', jsonb_build_object('equity', bs->'31')),
    _qawaem_check('rounding', (bs->>'_rounding')::numeric = 0, 'info',
      'فرق التقريب أُضيف إلى الأرباح المبقاة (خانة 26)', 'Rounding difference added to retained earnings (line 26)',
      jsonb_build_object('amount', bs->'_rounding')),
    _qawaem_check('drafts', not exists (select 1 from journal_entries where org_id = v_org and status = 'draft' and entry_date between v_from and v_to), 'warning',
      'توجد قيود مسودة في السنة لم تُرحّل — الأرقام لا تشملها', 'Draft journal entries in the year are not included', null));

  v_first := not exists (select 1 from journal_entries where org_id = v_org and status in ('posted','reversed') and entry_date < v_from);
  select count(*) into v_emp from employees
   where org_id = v_org and hire_date <= v_to and (termination_date is null or termination_date > v_to)
     and not (status = 'terminated' and termination_date is null);

  return jsonb_build_object(
    'year', p_year, 'from', v_from, 'to', v_to,
    'landing', jsonb_build_object('revenue', (pl->>'2')::numeric + (pl->>'3')::numeric, 'total_assets', bs->'13', 'employees', v_emp),
    'inputs', jsonb_build_object('separate', true, 'first_time', v_first, 'bs_method', 'liquidity', 'pl_method', 'function',
                                 'oci_method', 'net_of_tax', 'cf_method', 'indirect', 'ecommerce', (pl->>'3')::numeric <> 0),
    'bs', bs - '_rounding', 'pl', pl,
    'oci', jsonb_build_object('1', profit, '3', 0, '4', 0, '8', 0, '9', profit),
    'cf', cf, 'soce', soce,
    'rounding', bs->'_rounding', 'checks', checks);
end $$;

create or replace function _qawaem_soce_row(p_capital numeric, p_retained numeric, p_statutory numeric, p_other numeric, p_nci numeric)
returns jsonb language sql immutable as $$
  select jsonb_build_object('capital', p_capital, 'retained', p_retained, 'statutory', p_statutory, 'other', p_other,
                            'parent', p_capital + p_retained + p_statutory + p_other, 'nci', p_nci,
                            'total', p_capital + p_retained + p_statutory + p_other + p_nci)
$$;

create or replace function _qawaem_check(p_key text, p_ok boolean, p_severity text, p_ar text, p_en text, p_details jsonb)
returns jsonb language sql immutable as $$
  select jsonb_build_object('key', p_key, 'ok', coalesce(p_ok, false), 'severity', p_severity, 'ar', p_ar, 'en', p_en, 'details', p_details)
$$;
