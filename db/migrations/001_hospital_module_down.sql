-- =====================================================================
-- Migration 001 — hospital module : ROLLBACK (되돌리기)
-- =====================================================================
--  ⚠️ 이건 "최후 수단" 이다. 일반 비활성화는 아래를 먼저 쓴다:
--
--    [1순위] 기능만 끄기 (데이터·스키마 그대로, 즉시)
--        update public.feature_flags set enabled = false, updated_at = now()
--        where key = 'hospital_module';
--        → /api/facilities 는 domain = 'LTC' 만 반환 → 기존 화면과 완전 동일
--
--    [2순위] 코드 롤백
--        Vercel 대시보드에서 이전 배포로 Rollback (feature 브랜치는 배포 안 됨)
--
--    [3순위] 요양병원 데이터만 제거 (스키마 유지)
--        delete from public.facilities where domain = 'HOSPITAL';
--        -- hospital_profiles / facility_evaluations / facility_duplicate_candidates
--        --   → CASCADE 로 함께 삭제
--        -- facility_sources / facility_revisions
--        --   → facility_id 만 NULL 로, 원본·이력 기록은 보존 (감사)
--
--  아래 스크립트(스키마 원복)는 위 1~3으로 해결 안 될 때만.
--  facilities 의 기존 행은 삭제하지 않는다. domain/source/hira_ykiho 컬럼 값만 사라진다.
-- =====================================================================

begin;

-- 신규 테이블 제거 (요양병원 데이터 전부 소실 — 사전에 export 권장)
drop table if exists public.ingestion_runs                cascade;
drop table if exists public.facility_duplicate_candidates cascade;
drop table if exists public.facility_revisions            cascade;
drop table if exists public.facility_sources              cascade;
drop table if exists public.facility_evaluations          cascade;
drop table if exists public.hospital_profiles             cascade;

-- facilities 추가분 원복 (기존 행/기존 컬럼은 그대로)
drop index  if exists public.uq_facilities_hira_ykiho;
drop index  if exists public.idx_facilities_domain;
drop index  if exists public.idx_facilities_domain_sido;

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.facilities'::regclass and conname = 'facilities_domain_chk'
  ) then
    alter table public.facilities drop constraint facilities_domain_chk;
  end if;
end $$;

alter table public.facilities alter column domain drop default;
alter table public.facilities alter column source drop default;
alter table public.facilities drop column if exists hira_ykiho;
alter table public.facilities drop column if exists source;
alter table public.facilities drop column if exists domain;

-- feature_flags: hospital_module 만 제거 (다른 플래그가 생겼을 수 있으니 테이블은 유지)
delete from public.feature_flags where key = 'hospital_module';

-- 마이그레이션 기록 제거
delete from public.schema_migrations where version = '001_hospital_module';

commit;

-- feature_flags / schema_migrations 테이블 자체를 없애려면 (다른 데서 안 쓸 때만):
--   drop table if exists public.feature_flags;
--   drop table if exists public.schema_migrations;
