-- =====================================================================
-- 002_verify.sql  —  001 마이그레이션 실행 후 검증 (읽기 전용)
-- =====================================================================
--  실행: 001_hospital_module_up.sql 을 RUN 한 직후, 이 파일 전체를 붙여넣고 RUN.
--  아무것도 변경하지 않는다 (SELECT 만).
--
--  판정: [C] 결과에서 verdict 가 모두 'OK' 여야 성공.
--        하나라도 'FAIL' 이면 → 즉시 보고. (필요 시 001_hospital_module_down.sql 로 롤백)
--
--  ⚠️ 001 실행 전 preflight [A] 결과를 미리 캡처해 두면
--     "행 수 보존" 비교가 쉽다 (아래 C1 참고).
-- =====================================================================

-- ── 001 실행 전 facilities 행 수를 여기에 적어두고 비교 (선택) ──
--   \set  기능은 Supabase 편집기에서 안 되므로 눈으로 대조.
--   preflight A2 값 = ____________

with v as (

  -- C1. facilities 행 수 (마이그레이션 전과 동일해야 함 — additive 라 변동 0)
  select 'C1 facilities 행 수' as check_name,
         (select count(*)::text from public.facilities) as value,
         'preflight A2 와 동일해야 OK' as expect,
         'INFO' as verdict

  union all
  -- C2. 전 행이 domain='LTC'
  select 'C2 domain=LTC 행 수 == 전체',
         (select (count(*) = count(*) filter (where domain = 'LTC'))::text from public.facilities),
         'true',
         case when (select count(*) = count(*) filter (where domain='LTC') from public.facilities)
              then 'OK' else 'FAIL' end

  union all
  -- C3. domain NULL 없음
  select 'C3 domain IS NULL 행 수',
         (select count(*)::text from public.facilities where domain is null),
         '0',
         case when (select count(*) from public.facilities where domain is null) = 0
              then 'OK' else 'FAIL' end

  union all
  -- C4. domain='HOSPITAL' 없음 (1A 에서 병원 미적재)
  select 'C4 domain=HOSPITAL 행 수',
         (select count(*)::text from public.facilities where domain = 'HOSPITAL'),
         '0',
         case when (select count(*) from public.facilities where domain='HOSPITAL') = 0
              then 'OK' else 'FAIL' end

  union all
  -- C5. 전 행이 source='ltc_public'
  select 'C5 source=ltc_public 행 수 == 전체',
         (select (count(*) = count(*) filter (where source = 'ltc_public'))::text from public.facilities),
         'true',
         case when (select count(*) = count(*) filter (where source='ltc_public') from public.facilities)
              then 'OK' else 'FAIL' end

  union all
  -- C6. 기존 시설 id 보존 (샘플: 알려진 첫 행이 그대로 있는지)
  select 'C6 알려진 id 보존 (11111000006)',
         exists(select 1 from public.facilities where id = '11111000006')::text,
         'true (해당 id 가 원래 있었다면)',
         case when exists(select 1 from public.facilities where id = '11111000006')
              then 'OK' else 'CHECK' end

  union all
  -- C7. 신규 테이블 8개 모두 생성
  select 'C7 신규 테이블 생성 수 (기대 8)',
         (select count(*)::text from information_schema.tables
           where table_schema='public' and table_name in
           ('feature_flags','hospital_profiles','facility_evaluations','facility_sources',
            'facility_revisions','facility_duplicate_candidates','ingestion_runs','schema_migrations')),
         '8',
         case when (select count(*) from information_schema.tables
           where table_schema='public' and table_name in
           ('feature_flags','hospital_profiles','facility_evaluations','facility_sources',
            'facility_revisions','facility_duplicate_candidates','ingestion_runs','schema_migrations')) = 8
              then 'OK' else 'FAIL' end

  union all
  -- C8. 추가 컬럼 3개 생성
  select 'C8 facilities 추가 컬럼 수 (기대 3)',
         (select count(*)::text from information_schema.columns
           where table_schema='public' and table_name='facilities'
             and column_name in ('domain','source','hira_ykiho')),
         '3',
         case when (select count(*) from information_schema.columns
           where table_schema='public' and table_name='facilities'
             and column_name in ('domain','source','hira_ykiho')) = 3
              then 'OK' else 'FAIL' end

  union all
  -- C9. CHECK 제약 생성
  select 'C9 facilities_domain_chk 존재',
         exists(select 1 from pg_constraint
           where conrelid='public.facilities'::regclass and conname='facilities_domain_chk')::text,
         'true',
         case when exists(select 1 from pg_constraint
           where conrelid='public.facilities'::regclass and conname='facilities_domain_chk')
              then 'OK' else 'FAIL' end

  union all
  -- C10. 부분 UNIQUE 인덱스 생성
  select 'C10 uq_facilities_hira_ykiho 존재',
         exists(select 1 from pg_indexes
           where schemaname='public' and indexname='uq_facilities_hira_ykiho')::text,
         'true',
         case when exists(select 1 from pg_indexes
           where schemaname='public' and indexname='uq_facilities_hira_ykiho')
              then 'OK' else 'FAIL' end

  union all
  -- C11. facility_sources 복합 UNIQUE
  select 'C11 uq_facility_sources_system_extid 존재',
         exists(select 1 from pg_constraint
           where conrelid='public.facility_sources'::regclass and conname='uq_facility_sources_system_extid')::text,
         'true',
         case when exists(select 1 from pg_constraint
           where conrelid='public.facility_sources'::regclass and conname='uq_facility_sources_system_extid')
              then 'OK' else 'FAIL' end

  union all
  -- C12. feature_flags.hospital_module = false
  select 'C12 hospital_module 플래그',
         (select coalesce((select enabled::text from public.feature_flags where key='hospital_module'), '(없음)')),
         'false',
         case when (select enabled from public.feature_flags where key='hospital_module') is false
              then 'OK' else 'FAIL' end

  union all
  -- C13. 마이그레이션 기록
  select 'C13 schema_migrations 001 기록',
         exists(select 1 from public.schema_migrations where version='001_hospital_module')::text,
         'true',
         case when exists(select 1 from public.schema_migrations where version='001_hospital_module')
              then 'OK' else 'FAIL' end

  union all
  -- C14. 신규 테이블 RLS 활성
  select 'C14 신규 테이블 RLS 활성 수 (기대 8)',
         (select count(*)::text from pg_class
           where relnamespace='public'::regnamespace and relrowsecurity
             and relname in ('feature_flags','hospital_profiles','facility_evaluations','facility_sources',
                             'facility_revisions','facility_duplicate_candidates','ingestion_runs','schema_migrations')),
         '8',
         case when (select count(*) from pg_class
           where relnamespace='public'::regnamespace and relrowsecurity
             and relname in ('feature_flags','hospital_profiles','facility_evaluations','facility_sources',
                             'facility_revisions','facility_duplicate_candidates','ingestion_runs','schema_migrations')) = 8
              then 'OK' else 'FAIL' end

  union all
  -- C15. 기존 요양원 검색 영향 — eval_grade / capacity / phone 등 무손상 (NULL 폭증 없는지)
  select 'C15 eval_grade 채워진 행 수',
         (select count(*)::text from public.facilities where eval_grade is not null),
         'preflight 대비 감소 없어야 함',
         'INFO'

  union all
  select 'C15b phone 채워진 행 수',
         (select count(*)::text from public.facilities where phone is not null),
         'preflight 대비 감소 없어야 함',
         'INFO'
)
select * from v order by check_name;


-- ── 추가 참고 ────────────────────────────────────────────────────────
-- 새 컬럼/제약 상세
select conname, pg_get_constraintdef(oid) as def
from pg_constraint where conrelid='public.facilities'::regclass order by conname;

-- 001 이후 facilities 인덱스
select indexname, indexdef from pg_indexes
where schemaname='public' and tablename='facilities' order by indexname;
