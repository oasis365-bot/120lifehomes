-- =====================================================================
-- 007_verify.sql — 006 마이그레이션 실행 후 검증 (읽기 전용)
-- =====================================================================
--  실행: 006_hospital_collection_up.sql 을 RUN 한 직후, 이 파일 전체를
--  붙여넣고 RUN. 아무것도 변경하지 않는다 (SELECT 만).
--
--  판정: [C] 결과에서 verdict 가 모두 'OK' 여야 성공.
--        하나라도 'FAIL' 이면 → 즉시 보고. (필요 시 006_hospital_collection_down.sql 로 롤백)
-- =====================================================================

with v as (

  -- C1. 신규 테이블 3개 생성
  select 'C1 신규 테이블 생성 수(기대 3)' as check_name,
         (select count(*)::text from information_schema.tables
           where table_schema='public' and table_name in
           ('hospital_collection_jobs','hospital_collection_items','hospital_hira_daily_usage')) as value,
         '3' as expect,
         case when (select count(*) from information_schema.tables
           where table_schema='public' and table_name in
           ('hospital_collection_jobs','hospital_collection_items','hospital_hira_daily_usage')) = 3
              then 'OK' else 'FAIL' end as verdict

  union all
  -- C2. hospital_collection_jobs 의 CHECK 제약 5개
  select 'C2 hospital_collection_jobs CHECK 수(기대 5)',
         (select count(*)::text from pg_constraint
           where conrelid='public.hospital_collection_jobs'::regclass and contype='c'),
         '5',
         case when (select count(*) from pg_constraint
           where conrelid='public.hospital_collection_jobs'::regclass and contype='c') = 5
              then 'OK' else 'FAIL' end

  union all
  -- C3. hospital_collection_jobs 활성-작업 partial unique index 존재
  select 'C3 uq_hospital_collection_jobs_active_per_job 존재',
         exists(select 1 from pg_indexes
           where schemaname='public' and indexname='uq_hospital_collection_jobs_active_per_job')::text,
         'true',
         case when exists(select 1 from pg_indexes
           where schemaname='public' and indexname='uq_hospital_collection_jobs_active_per_job')
              then 'OK' else 'FAIL' end

  union all
  -- C3b. 그 인덱스가 정확히 3개 상태(pending/running/paused_for_today)만 커버하는지
  --      (활성 상태 범위 고정 — indexdef 문자열에 세 상태가 모두 있고 터미널 상태는 없어야 함)
  select 'C3b 활성 상태 범위 고정(pending/running/paused_for_today 만)',
         (select indexdef from pg_indexes
           where schemaname='public' and indexname='uq_hospital_collection_jobs_active_per_job'),
         'WHERE 절에 completed/failed/cancelled 미포함, 3 상태만 포함',
         case when (
              (select indexdef from pg_indexes where schemaname='public' and indexname='uq_hospital_collection_jobs_active_per_job') ilike '%pending%'
          and (select indexdef from pg_indexes where schemaname='public' and indexname='uq_hospital_collection_jobs_active_per_job') ilike '%running%'
          and (select indexdef from pg_indexes where schemaname='public' and indexname='uq_hospital_collection_jobs_active_per_job') ilike '%paused_for_today%'
          and (select indexdef from pg_indexes where schemaname='public' and indexname='uq_hospital_collection_jobs_active_per_job') not ilike '%completed%'
          and (select indexdef from pg_indexes where schemaname='public' and indexname='uq_hospital_collection_jobs_active_per_job') not ilike '%failed%'
          and (select indexdef from pg_indexes where schemaname='public' and indexname='uq_hospital_collection_jobs_active_per_job') not ilike '%cancelled%'
             ) then 'OK' else 'FAIL' end

  union all
  -- C4. hospital_collection_items 의 UNIQUE 제약 2개 + CHECK 4개
  select 'C4 hospital_collection_items UNIQUE 수(기대 2)',
         (select count(*)::text from pg_constraint
           where conrelid='public.hospital_collection_items'::regclass and contype='u'),
         '2',
         case when (select count(*) from pg_constraint
           where conrelid='public.hospital_collection_items'::regclass and contype='u') = 2
              then 'OK' else 'FAIL' end

  union all
  select 'C5 hospital_collection_items CHECK 수(기대 4)',
         (select count(*)::text from pg_constraint
           where conrelid='public.hospital_collection_items'::regclass and contype='c'),
         '4',
         case when (select count(*) from pg_constraint
           where conrelid='public.hospital_collection_items'::regclass and contype='c') = 4
              then 'OK' else 'FAIL' end

  union all
  -- C6. hospital_collection_items 조회 인덱스
  select 'C6 idx_hospital_collection_items_job_status_ordinal 존재',
         exists(select 1 from pg_indexes
           where schemaname='public' and indexname='idx_hospital_collection_items_job_status_ordinal')::text,
         'true',
         case when exists(select 1 from pg_indexes
           where schemaname='public' and indexname='idx_hospital_collection_items_job_status_ordinal')
              then 'OK' else 'FAIL' end

  union all
  -- C7. hospital_collection_items 에 facilities FK 가 "없음"을 확정(의도적 비연결)
  select 'C7 hospital_collection_items → facilities FK 없음(의도적)',
         (select count(*)::text from pg_constraint
           where conrelid='public.hospital_collection_items'::regclass and contype='f'
             and confrelid='public.facilities'::regclass),
         '0',
         case when (select count(*) from pg_constraint
           where conrelid='public.hospital_collection_items'::regclass and contype='f'
             and confrelid='public.facilities'::regclass) = 0
              then 'OK' else 'FAIL' end

  union all
  -- C8. hospital_collection_items 에 ykiho 원문·기관명·주소·전화·URL·raw·비밀 관련 컬럼이
  --     전혀 없는지(허용 컬럼 allowlist 밖은 전부 금지) — 이름 패턴으로 방어적 스캔
  select 'C8 hospital_collection_items 금지 컬럼명 패턴 존재(기대 0)',
         (select count(*)::text from information_schema.columns
           where table_schema='public' and table_name='hospital_collection_items'
             and (column_name ilike '%ykiho%' or column_name ilike '%name%' or column_name ilike '%addr%'
                  or column_name ilike '%phone%' or column_name ilike '%url%' or column_name ilike '%raw%'
                  or column_name ilike '%secret%' or column_name ilike '%key%' or column_name ilike '%token%')),
         '0',
         case when (select count(*) from information_schema.columns
           where table_schema='public' and table_name='hospital_collection_items'
             and (column_name ilike '%ykiho%' or column_name ilike '%name%' or column_name ilike '%addr%'
                  or column_name ilike '%phone%' or column_name ilike '%url%' or column_name ilike '%raw%'
                  or column_name ilike '%secret%' or column_name ilike '%key%' or column_name ilike '%token%')) = 0
              then 'OK' else 'FAIL' end

  union all
  -- C9. hospital_hira_daily_usage CHECK 2개 + PK 가 date 타입
  select 'C9 hospital_hira_daily_usage CHECK 수(기대 2)',
         (select count(*)::text from pg_constraint
           where conrelid='public.hospital_hira_daily_usage'::regclass and contype='c'),
         '2',
         case when (select count(*) from pg_constraint
           where conrelid='public.hospital_hira_daily_usage'::regclass and contype='c') = 2
              then 'OK' else 'FAIL' end

  union all
  select 'C10 hospital_hira_daily_usage.usage_date 타입',
         (select data_type from information_schema.columns
           where table_schema='public' and table_name='hospital_hira_daily_usage' and column_name='usage_date'),
         'date',
         case when (select data_type from information_schema.columns
           where table_schema='public' and table_name='hospital_hira_daily_usage' and column_name='usage_date') = 'date'
              then 'OK' else 'FAIL' end

  union all
  -- C11. 신규 테이블 3개 RLS 활성
  select 'C11 신규 테이블 RLS 활성 수(기대 3)',
         (select count(*)::text from pg_class
           where relnamespace='public'::regnamespace and relrowsecurity
             and relname in ('hospital_collection_jobs','hospital_collection_items','hospital_hira_daily_usage')),
         '3',
         case when (select count(*) from pg_class
           where relnamespace='public'::regnamespace and relrowsecurity
             and relname in ('hospital_collection_jobs','hospital_collection_items','hospital_hira_daily_usage')) = 3
              then 'OK' else 'FAIL' end

  union all
  -- C12. 신규 테이블에 공개 정책(policy) 이 0개(anon/authenticated 접근 불가)
  select 'C12 신규 테이블 policy 수(기대 0)',
         (select count(*)::text from pg_policies
           where schemaname='public'
             and tablename in ('hospital_collection_jobs','hospital_collection_items','hospital_hira_daily_usage')),
         '0',
         case when (select count(*) from pg_policies
           where schemaname='public'
             and tablename in ('hospital_collection_jobs','hospital_collection_items','hospital_hira_daily_usage')) = 0
              then 'OK' else 'FAIL' end

  union all
  -- C13. 신규 함수 4개 생성
  select 'C13 신규 함수 생성 수(기대 4)',
         (select count(*)::text from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname='public' and p.proname in
           ('hospital_collection_job_acquire_lease','hospital_collection_job_heartbeat',
            'hospital_collection_job_release_lease','hospital_hira_reserve_daily_calls')),
         '4',
         case when (select count(*) from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname='public' and p.proname in
           ('hospital_collection_job_acquire_lease','hospital_collection_job_heartbeat',
            'hospital_collection_job_release_lease','hospital_hira_reserve_daily_calls')) = 4
              then 'OK' else 'FAIL' end

  union all
  -- C14. 신규 함수 4개 전부 SECURITY DEFINER
  select 'C14 신규 함수 SECURITY DEFINER 수(기대 4)',
         (select count(*)::text from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname='public' and p.prosecdef and p.proname in
           ('hospital_collection_job_acquire_lease','hospital_collection_job_heartbeat',
            'hospital_collection_job_release_lease','hospital_hira_reserve_daily_calls')),
         '4',
         case when (select count(*) from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname='public' and p.prosecdef and p.proname in
           ('hospital_collection_job_acquire_lease','hospital_collection_job_heartbeat',
            'hospital_collection_job_release_lease','hospital_hira_reserve_daily_calls')) = 4
              then 'OK' else 'FAIL' end

  union all
  -- C15. service_role 만 execute 권한을 가짐 (public/anon/authenticated 는 0)
  select 'C15 신규 함수 public/anon/authenticated execute 권한 수(기대 0)',
         (select count(*)::text from information_schema.routine_privileges
           where routine_schema='public' and privilege_type='EXECUTE'
             and grantee in ('PUBLIC','anon','authenticated')
             and routine_name in ('hospital_collection_job_acquire_lease','hospital_collection_job_heartbeat',
                                   'hospital_collection_job_release_lease','hospital_hira_reserve_daily_calls')),
         '0',
         case when (select count(*) from information_schema.routine_privileges
           where routine_schema='public' and privilege_type='EXECUTE'
             and grantee in ('PUBLIC','anon','authenticated')
             and routine_name in ('hospital_collection_job_acquire_lease','hospital_collection_job_heartbeat',
                                   'hospital_collection_job_release_lease','hospital_hira_reserve_daily_calls')) = 0
              then 'OK' else 'FAIL' end

  union all
  select 'C16 신규 함수 service_role execute 권한 수(기대 4)',
         (select count(*)::text from information_schema.routine_privileges
           where routine_schema='public' and privilege_type='EXECUTE' and grantee='service_role'
             and routine_name in ('hospital_collection_job_acquire_lease','hospital_collection_job_heartbeat',
                                   'hospital_collection_job_release_lease','hospital_hira_reserve_daily_calls')),
         '4',
         case when (select count(*) from information_schema.routine_privileges
           where routine_schema='public' and privilege_type='EXECUTE' and grantee='service_role'
             and routine_name in ('hospital_collection_job_acquire_lease','hospital_collection_job_heartbeat',
                                   'hospital_collection_job_release_lease','hospital_hira_reserve_daily_calls')) = 4
              then 'OK' else 'FAIL' end

  union all
  -- C17. 마이그레이션 기록
  select 'C17 schema_migrations 006 기록',
         exists(select 1 from public.schema_migrations where version='006_hospital_collection')::text,
         'true',
         case when exists(select 1 from public.schema_migrations where version='006_hospital_collection')
              then 'OK' else 'FAIL' end

  union all
  -- C18. 기존 001 스키마·LTC 데이터 무손상 (facilities 행 수는 이 migration 으로 절대 안 변함)
  select 'C18 facilities 존재 및 LTC 카운트 무영향 확인용(참고치)',
         (select count(*)::text from public.facilities where domain='LTC'),
         'migration 전후 동일해야 함(직접 대조)',
         'INFO'

  union all
  -- C19. 이번 migration 이 어떤 실제 데이터도 넣지 않았는지(전부 0건이어야 함)
  select 'C19 신규 테이블 행 수 합계(기대 0)',
         (
           (select count(*) from public.hospital_collection_jobs) +
           (select count(*) from public.hospital_collection_items) +
           (select count(*) from public.hospital_hira_daily_usage)
         )::text,
         '0',
         case when (
           (select count(*) from public.hospital_collection_jobs) +
           (select count(*) from public.hospital_collection_items) +
           (select count(*) from public.hospital_hira_daily_usage)
         ) = 0 then 'OK' else 'FAIL' end
)
select * from v order by check_name;
