-- =====================================================================
-- 005_preflight.sql — 006 마이그레이션(전국 요양병원 수집 checkpoint/lease/
-- 일일 쿼터 스키마, 1B-5B) 실행 전 점검 (읽기 전용)
-- =====================================================================
--  실행: Supabase SQL Editor 에 이 파일 전체를 붙여넣고 RUN.
--  아무것도 변경하지 않는다 (SELECT 만).
--
--  판정: 아래 [A] 결과에서 verdict 가 하나라도 'STOP' 이면
--        → 006_hospital_collection_up.sql 을 실행하지 말고 보고할 것.
--        모두 'OK' 이면 006 실행 가능.
--
--  ⚠️ 003/004 는 이 migration 과 무관하다 — db/migrations/README.md 에
--     이미 다른 목적(facilities.domain NOT NULL 확정 / 1B 필드 매핑 보강)으로
--     예약돼 있으므로 절대 재사용하지 않는다. 005/006/007 은 그 두 번호와
--     충돌하지 않는 새 번호다.
-- =====================================================================

with checks as (

  -- A1. schema_migrations 존재(001 이 이미 적용돼 있어야 함 — 전제조건)
  select 'A1 schema_migrations 테이블 존재' as check_name,
         (to_regclass('public.schema_migrations') is not null)::text as value,
         case when to_regclass('public.schema_migrations') is not null then 'OK' else 'STOP' end as verdict

  union all
  -- A2. 001 마이그레이션 기록 존재(선행 조건 확인)
  select 'A2 001_hospital_module 기록 존재',
         coalesce((select exists(select 1 from public.schema_migrations where version='001_hospital_module')::text), 'false'),
         case when to_regclass('public.schema_migrations') is not null
                   and exists(select 1 from public.schema_migrations where version='001_hospital_module')
              then 'OK' else 'STOP' end

  union all
  -- A3. 006 을 이미 적용한 적 있는가(재실행 방지 안내 — STOP 은 아니고 CHECK, up 이 idempotent 라 안전은 함)
  select 'A3 006_hospital_collection 기존 기록',
         coalesce((select exists(select 1 from public.schema_migrations where version='006_hospital_collection')::text), 'false'),
         case when exists(select 1 from public.schema_migrations where version='006_hospital_collection')
              then 'CHECK(이미 적용됨 — 재실행은 idempotent 하지만 의도 확인)' else 'OK' end

  union all
  -- A4. 신규 테이블 3개 중 이미 존재하는 것 (있으면 STOP)
  select 'A4 신규 테이블 기존재 개수(기대 0)',
         (select count(*)::text from information_schema.tables
           where table_schema='public' and table_name in
           ('hospital_collection_jobs','hospital_collection_items','hospital_hira_daily_usage')),
         case when (select count(*) from information_schema.tables
           where table_schema='public' and table_name in
           ('hospital_collection_jobs','hospital_collection_items','hospital_hira_daily_usage')) = 0
              then 'OK' else 'STOP' end

  union all
  -- A5. 신규 함수 4개 중 이미 존재하는 것 (있으면 STOP — 이름만 겹쳐도 시그니처 충돌 가능성)
  select 'A5 신규 함수 기존재 개수(기대 0)',
         (select count(*)::text from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname in
           ('hospital_collection_job_acquire_lease','hospital_collection_job_heartbeat',
            'hospital_collection_job_release_lease','hospital_hira_reserve_daily_calls')),
         case when (select count(*) from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname in
           ('hospital_collection_job_acquire_lease','hospital_collection_job_heartbeat',
            'hospital_collection_job_release_lease','hospital_hira_reserve_daily_calls')) = 0
              then 'OK' else 'STOP' end

  union all
  -- A6. 추가 예정 제약/인덱스 이름 충돌
  select 'A6 제약·인덱스 이름 충돌(기대 0)',
         (select count(*)::text from pg_class
           where relname in (
             'hospital_collection_jobs_status_chk','hospital_collection_jobs_phase_chk',
             'hospital_collection_jobs_discovery_page_chk','hospital_collection_jobs_snapshot_total_chk',
             'hospital_collection_jobs_counts_nonneg_chk','uq_hospital_collection_jobs_active_per_job',
             'hospital_collection_jobs_job_chk','hospital_collection_jobs_lease_owner_len_chk',
             'hospital_collection_jobs_last_error_code_len_chk',
             'idx_hospital_collection_jobs_job_status','idx_hospital_collection_jobs_lease_expires',
             'hospital_collection_items_status_chk','hospital_collection_items_attempt_count_chk',
             'hospital_collection_items_ordinal_chk','hospital_collection_items_facility_id_format_chk',
             'hospital_collection_items_facility_id_len_chk','hospital_collection_items_last_error_code_len_chk',
             'uq_hospital_collection_items_job_facility','uq_hospital_collection_items_job_ordinal',
             'idx_hospital_collection_items_job_status_ordinal',
             'hospital_hira_daily_usage_reserved_nonneg_chk','hospital_hira_daily_usage_completed_nonneg_chk'
           )),
         case when (select count(*) from pg_class
           where relname in (
             'hospital_collection_jobs_status_chk','hospital_collection_jobs_phase_chk',
             'hospital_collection_jobs_discovery_page_chk','hospital_collection_jobs_snapshot_total_chk',
             'hospital_collection_jobs_counts_nonneg_chk','uq_hospital_collection_jobs_active_per_job',
             'hospital_collection_jobs_job_chk','hospital_collection_jobs_lease_owner_len_chk',
             'hospital_collection_jobs_last_error_code_len_chk',
             'idx_hospital_collection_jobs_job_status','idx_hospital_collection_jobs_lease_expires',
             'hospital_collection_items_status_chk','hospital_collection_items_attempt_count_chk',
             'hospital_collection_items_ordinal_chk','hospital_collection_items_facility_id_format_chk',
             'hospital_collection_items_facility_id_len_chk','hospital_collection_items_last_error_code_len_chk',
             'uq_hospital_collection_items_job_facility','uq_hospital_collection_items_job_ordinal',
             'idx_hospital_collection_items_job_status_ordinal',
             'hospital_hira_daily_usage_reserved_nonneg_chk','hospital_hira_daily_usage_completed_nonneg_chk'
           )) = 0
              then 'OK' else 'STOP' end

  union all
  -- A7. gen_random_uuid() 사용 가능 여부(PG13+ 내장 — pgcrypto 확장 불필요. 실패하면 STOP)
  select 'A7 gen_random_uuid() 사용 가능',
         (select (gen_random_uuid() is not null)::text),
         case when (select gen_random_uuid() is not null) then 'OK' else 'STOP' end

  union all
  -- A8. 필요한 역할(anon/authenticated/service_role) 존재 — GRANT/REVOKE 대상
  select 'A8 anon/authenticated/service_role 역할 존재(기대 3)',
         (select count(*)::text from pg_roles where rolname in ('anon','authenticated','service_role')),
         case when (select count(*) from pg_roles where rolname in ('anon','authenticated','service_role')) = 3
              then 'OK' else 'STOP' end
)
select * from checks order by check_name;


-- ─────────────────────────────────────────────────────────────────────
-- [B] 참고 정보 (보고용, 판정에는 불필요)
-- ─────────────────────────────────────────────────────────────────────

-- B1. public 스키마 전체 테이블 목록
select table_name from information_schema.tables
where table_schema='public' and table_type='BASE TABLE'
order by table_name;

-- B2. 003/004 가 이미 적용돼 있는지(있다면 이 migration 이전에 다른 목적으로
--     선점됐다는 뜻 — 006 번호 선택의 전제였던 "003/004 미사용" 가정을 재확인)
select version, applied_at, note from public.schema_migrations
where version like '003%' or version like '004%'
order by version;
