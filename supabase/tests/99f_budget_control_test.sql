-- Project budget: lines added freely, saved lines locked, changes approved by the administrator
\set QUIET on
set client_min_messages = warning;
-- a project manager in org A (projects.manage, no budget approval)
insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-0000000000f1', 'budget-pm@a.test', '{"full_name":"PM"}');
set role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', false);
select t.act('00000000-0000-0000-0000-00000000000a', (select id from t.v where k = 'orgA'));
select add_member('budget-pm@a.test', 'project_manager', 'مدير المشروع');
insert into projects (name_ar) values ('مشروع الميزانية') returning id as prj \gset

select t.act('00000000-0000-0000-0000-0000000000f1', (select id from t.v where k = 'orgA'));
select t.ok(not has_perm('budget.approve') and has_perm('projects.manage'), 'project manager: manage, not approve');
insert into project_budget_lines (project_id, category, description, amount) values
  (:'prj', 'materials', 'حديد تسليح', 5000000), (:'prj', 'labour', 'عمالة الهيكل', 1000000);
select t.ok((select sum(amount) = 6000000 from project_budget_lines where project_id = :'prj'), 'lines saved, total computed');
select t.fails(format($$insert into project_budget_lines (project_id, category, description, amount) values ('%s', 'other', 'x', 0)$$, :'prj'), 'above zero');

-- saved lines are locked
select id as l1 from project_budget_lines where project_id = :'prj' and description = 'حديد تسليح' \gset
select t.fails(format($$update project_budget_lines set amount = 1 where id = '%s'$$, :'l1'), 'locked');
select t.fails(format($$delete from project_budget_lines where id = '%s'$$, :'l1'), 'locked');

-- the project manager asks; nothing changes until approved
select request_budget_change(:'l1', 'update', 'ارتفاع أسعار الحديد', 'materials', 'حديد تسليح', 5600000) as rq \gset
select t.ok((select amount = 5000000 from project_budget_lines where id = :'l1'), 'request alone changes nothing');
select t.fails(format($$select request_budget_change('%s', 'delete', 'x')$$, :'l1'), 'already has a change waiting');
select t.fails(format($$select decide_budget_change('%s', true)$$, :'rq'), 'permission denied: budget.approve');
select t.fails(format($$select request_budget_change('%s', 'update', '', 'materials', 'x', 1)$$, :'l1'), 'reason');

-- the owner approves; a rejection needs a reason
select t.act('00000000-0000-0000-0000-00000000000a', (select id from t.v where k = 'orgA'));
select decide_budget_change(:'rq', true, 'موافق');
select t.ok((select amount = 5600000 from project_budget_lines where id = :'l1'), 'approved change applied');
select t.ok((select status = 'approved' and old_amount = 5000000 and new_amount = 5600000 and requested_name = 'مدير المشروع' from budget_change_requests where id = :'rq'),
            'request kept with old and new values');
select t.fails(format($$select decide_budget_change('%s', true)$$, :'rq'), 'pending budget change not found');

select t.act('00000000-0000-0000-0000-0000000000f1', (select id from t.v where k = 'orgA'));
select id as l2 from project_budget_lines where project_id = :'prj' and description = 'عمالة الهيكل' \gset
select request_budget_change(:'l2', 'delete', 'نقل العمالة لمقاول باطن') as rq2 \gset
select t.act('00000000-0000-0000-0000-00000000000a', (select id from t.v where k = 'orgA'));
select t.fails(format($$select decide_budget_change('%s', false)$$, :'rq2'), 'reason for the rejection');
select decide_budget_change(:'rq2', false, 'العمالة باقية في الميزانية');
select t.ok(exists (select 1 from project_budget_lines where id = :'l2'), 'rejected delete leaves the line');

-- an approver's own request applies at once
select request_budget_change(:'l2', 'delete', 'إلغاء البند') as rq3 \gset
select t.ok(not exists (select 1 from project_budget_lines where id = :'l2')
            and (select status = 'approved' from budget_change_requests where id = :'rq3'), 'administrator change applied immediately and recorded');
select t.fails(format($$update budget_change_requests set status = 'approved' where id = '%s'$$, :'rq2'), 'permission denied');

-- deleting the project removes its locked lines
delete from projects where id = :'prj';
select t.ok(not exists (select 1 from project_budget_lines where project_id = :'prj'), 'project delete removes its budget');
reset role;
\echo '  ✓ budget: lines locked once saved, changes through administrator approval, history kept'
