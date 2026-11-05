-- Ajeer temporary workers: saved in one call, three-year cap, no overlaps, expiry alerts
\set QUIET on
set client_min_messages = warning;
set role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', false);
select t.act('00000000-0000-0000-0000-00000000000a', (select id from t.v where k = 'orgA'));
insert into projects (code, name_ar) values ('AJR-1', 'مشروع أجير') returning id as prj \gset

-- the form and the Excel import save the same way, all rows or none
select save_temp_workers(jsonb_build_array(
  jsonb_build_object('worker_name', ' محمد علي ', 'iqama_no', '2123456789', 'nationality', 'EG', 'profession', 'نجار',
                     'provider_name', 'مؤسسة الإعارة', 'provider_unified_no', '7001234567', 'permit_no', 'AJ-100',
                     'start_date', current_date - 20, 'end_date', current_date + 10, 'project_id', :'prj', 'monthly_cost', 3500),
  jsonb_build_object('worker_name', 'راج كومار', 'iqama_no', '2987654321', 'profession', 'حداد', 'provider_name', 'مؤسسة الإعارة',
                     'permit_no', '', 'start_date', current_date - 200, 'end_date', current_date - 3)));
select t.ok((select count(*) from temp_workers) = 2, 'two contracts saved');
select t.ok((select worker_name = 'محمد علي' and monthly_cost = 3500 and project_id = :'prj' from temp_workers where permit_no = 'AJ-100'), 'values stored, name trimmed');
select t.ok((select permit_no is null from temp_workers where iqama_no = '2987654321'), 'empty permit number stored as none');

-- one bad row rolls the whole batch back
select t.fails($$select save_temp_workers('[{"worker_name":"س","iqama_no":"2000000001","profession":"عامل","provider_name":"م","start_date":"2026-01-01","end_date":"2026-02-01"},
                                          {"worker_name":"ص","iqama_no":"123","profession":"عامل","provider_name":"م","start_date":"2026-01-01","end_date":"2026-02-01"}]')$$,
               'temp_workers_iqama');
select t.ok(not exists (select 1 from temp_workers where iqama_no = '2000000001'), 'batch is all or nothing');

-- platform rules
select t.fails($$select save_temp_workers('[{"worker_name":"س","iqama_no":"2000000002","profession":"عامل","provider_name":"م","start_date":"2026-01-01","end_date":"2029-01-01"}]')$$,
               'temp_workers_max_3y');
select t.fails($$select save_temp_workers('[{"worker_name":"س","iqama_no":"2000000002","profession":"عامل","provider_name":"م","start_date":"2026-02-01","end_date":"2026-01-01"}]')$$,
               'temp_workers_dates');
select t.fails(format($$select save_temp_workers('[{"worker_name":"محمد","iqama_no":"2123456789","profession":"نجار","provider_name":"م","start_date":"%s","end_date":"%s"}]')$$,
                      current_date, current_date + 60), 'already has an Ajeer contract');
select t.fails($$select save_temp_workers('[{"worker_name":"س","iqama_no":"2000000003","profession":"عامل","provider_name":"م","permit_no":"AJ-100","start_date":"2026-01-01","end_date":"2026-02-01"}]')$$,
               'duplicate key');
-- a renewal right after the end is not an overlap
select save_temp_workers(jsonb_build_array(jsonb_build_object('worker_name', 'راج كومار', 'iqama_no', '2987654321', 'profession', 'حداد',
         'provider_name', 'مؤسسة الإعارة', 'start_date', current_date - 2, 'end_date', current_date + 90)));
select t.ok((select count(*) from temp_workers where iqama_no = '2987654321') = 2, 'renewal saved as a new contract');

-- ending early: update the end date with a reason
select id as c from temp_workers where permit_no = 'AJ-100' \gset
select save_temp_workers(jsonb_build_array(jsonb_build_object('id', :'c', 'end_date', current_date - 1, 'end_reason', 'انتهاء أعمال النجارة')));
select t.ok((select end_date = current_date - 1 and end_reason is not null and worker_name = 'محمد علي' from temp_workers where id = :'c'), 'ended early, other fields kept');

-- alerts: ending within the window or ended in the last week
select t.ok((select count(*) from ajeer_expiring(30)) = 2, 'two contracts in the alert window');
select t.ok((select project = 'مشروع أجير' and days_left = -1 from ajeer_expiring(30) where id = :'c'), 'alert carries the project and days left');

-- HR without salary access can manage; another company sees nothing
select t.act('00000000-0000-0000-0000-00000000000b', (select id from t.v where k = 'orgB'));
select t.ok((select count(*) from temp_workers) = 0, 'org B sees no Ajeer contracts');
select t.fails(format($$select save_temp_workers('[{"id":"%s","end_date":"2020-01-01"}]')$$, :'c'), 'contract not found');
reset role;
\echo '  ✓ Ajeer: batch save, three-year cap, no overlaps, renewals, early end, alerts'
