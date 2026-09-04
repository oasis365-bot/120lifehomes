-- =====================================================================
-- 000_preflight.sql  —  001 마이그레이션 실행 전 점검 (읽기 전용)
-- =====================================================================
--  실행: Supabase SQL Editor 에 이 파일 전체를 붙여넣고 RUN.
--  아무것도 변경하지 않는다 (SELECT 만).
--
--  판정: 아래 [A] 결과에서 verdict 가 하나라도 'STOP' 이면
--        → 001_hospital_module_up.sql 을 실행하지 말고 보고할 것.
--        모두 'OK' 이면 001 실행 가능.
-- =====================================================================


-- ─────────────────────────────────────────────────────────────────────
-- [A] GO / NO-GO 체크  (이 결과를 캡처해서 보고)
-- ─────────────────────────────────────────────────────────────────────
with checks as (

  -- A1. facilities 테이블 존재
  select 'A1 facilities 테이블 존재' as check_name,
         (to_regclass('public.facilities') is not null)::text as value,
         case when to_regclass('public.facilities') is not null then 'OK' else 'STOP' end as verdict

  union all
  -- A2. facilities 행 수 (0 이면 이상 → 중단)
  select 'A2 facilities 행 수',
         (select count(*)::text from public.facilities),
         case when (select count(*) from public.facilities) > 0 then 'OK' else 'STOP' end

  union all
  -- A3. facilities.id 중복 (PK 라 0 이어야 정상)
  select 'A3 facilities.id 중복 건수',
         (select coalesce(sum(c-1),0)::text
            from (select count(*) c from public.facilities group by id having count(*)>1) x),
         case when (select coalesce(sum(c-1),0)
                      from (select count(*) c from public.facilities group by id having count(*)>1) x) = 0
              then 'OK' else 'STOP' end

  union all
  -- A4. 추가 예정 컬럼(domain) 이 이미 있는가  → 있으면 STOP(예상과 다름, 원인 파악 필요)
  select 'A4 facilities.domain 기존재',
         exists(select 1 from information_schema.columns
                where table_schema='public' and table_name='facilities' and column_name='domain')::text,
         case when exists(select 1 from information_schema.columns
                where table_schema='public' and table_name='facilities' and column_name='domain')
              then 'STOP' else 'OK' end

  union all
  -- A5. 추가 예정 컬럼(source) 기존재
  select 'A5 facilities.source 기존재',
         exists(select 1 from information_schema.columns
                where table_schema='public' and table_name='facilities' and column_name='source')::text,
         case when exists(select 1 from information_schema.columns
                where table_schema='public' and table_name='facilities' and column_name='source')
              then 'STOP' else 'OK' end

  union all
  -- A6. 추가 예정 컬럼(hira_ykiho) 기존재
  select 'A6 facilities.hira_ykiho 기존재',
         exists(select 1 from information_schema.columns
                where table_schema='public' and table_name='facilities' and column_name='hira_ykiho')::text,
         case when exists(select 1 from information_schema.columns
                where table_schema='public' and table_name='facilities' and column_name='hira_ykiho')
              then 'STOP' else 'OK' end

  union all
  -- A7. 신규 테이블 중 이미 존재하는 것 (있으면 STOP)
  select 'A7 신규 테이블 기존재 개수',
         (select count(*)::text from information_schema.tables
           where table_schema='public' and table_name in
           ('feature_flags','hospital_profiles','facility_evaluations','facility_sources',
            'facility_revisions','facility_duplicate_candidates','ingestion_runs','schema_migrations')),
         case when (select count(*) from information_schema.tables
           where table_schema='public' and table_name in
           ('feature_flags','hospital_profiles','facility_evaluations','facility_sources',
            'facility_revisions','facility_duplicate_candidates','ingestion_runs','schema_migrations')) = 0
              then 'OK' else 'STOP' end

  union all
  -- A8. 추가 예정 제약/인덱스 이름 충돌
  select 'A8 제약·인덱스 이름 충돌',
         (select count(*)::text from pg_class
           where relname in ('facilities_domain_chk','uq_facilities_hira_ykiho',
                             'idx_facilities_domain','idx_facilities_domain_sido')),
         case when (select count(*) from pg_class
           where relname in ('facilities_domain_chk','uq_facilities_hira_ykiho',
                             'idx_facilities_domain','idx_facilities_domain_sido')) = 0
              then 'OK' else 'STOP' end

  union all
  -- A9. 예상치 못한 트리거가 facilities 에 있는가 (있으면 검토 필요 — WARN)
  select 'A9 facilities 트리거 수',
         (select count(*)::text from pg_trigger t
            join pg_class c on c.oid=t.tgrelid
           where c.relname='facilities' and not t.tgisinternal),
         case when (select count(*) from pg_trigger t
            join pg_class c on c.oid=t.tgrelid
           where c.relname='facilities' and not t.tgisinternal) = 0
              then 'OK' else 'WARN' end
)
select * from checks order by check_name;


-- ─────────────────────────────────────────────────────────────────────
-- [B] 참고 정보  (보고용, 판정에는 불필요)
-- ─────────────────────────────────────────────────────────────────────

-- B1. facilities 현재 컬럼 전체
select ordinal_position, column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema='public' and table_name='facilities'
order by ordinal_position;

-- B2. facilities 인덱스
select indexname, indexdef
from pg_indexes where schemaname='public' and tablename='facilities'
order by indexname;

-- B3. facilities 제약조건
select conname, contype, pg_get_constraintdef(oid) as def
from pg_constraint where conrelid='public.facilities'::regclass
order by conname;

-- B4. public 스키마 전체 테이블 목록
select table_name from information_schema.tables
where table_schema='public' and table_type='BASE TABLE'
order by table_name;

-- B5. type_label 분포 (요양병원이 이미 섞여있지 않은지 확인)
select coalesce(type_label,'(null)') as type_label, count(*)
from public.facilities group by 1 order by 2 desc;
-- 기대: '노인요양시설','노인요양공동생활가정','주야간보호','방문요양' 등만.
--       '요양병원' 이 있으면 원인 파악 후 진행.
