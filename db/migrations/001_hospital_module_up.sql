-- =====================================================================
-- Migration 001 — hospital module (요양병원 통합) : 기반 스키마
-- 방향: UP (적용)
-- =====================================================================
--  전제:
--   · db/baseline_schema.sql 의 [검증 쿼리]로 현재 스키마를 먼저 확인했다.
--   · facilities 데이터 백업(NDJSON export)을 받아 두었다.
--   · 이 migration 은 ADDITIVE 전용이다.
--       - 기존 컬럼 rename / drop / type change  → 없음
--       - 기존 데이터 delete / 재생성            → 없음
--       - 기존 인덱스 / 제약 변경                → 없음
--
--  실행: Supabase SQL Editor 에 이 파일 전체를 붙여넣고 1회 실행.
--        (자동 번역 끄기 · 실행 후 db/migrations/README.md 의 검증쿼리 확인)
--
--  재실행 안전: 모든 문장이 IF NOT EXISTS / 가드 처리됨 (idempotent).
--
--  FK ON DELETE 정책 (시설 물리 삭제는 원칙적으로 안 하지만, 롤백 대비):
--    · hospital_profiles / facility_evaluations / facility_duplicate_candidates
--        → CASCADE  (1:1 파생정보 · 재수집 가능 · 작업 큐. 시설 없으면 무의미)
--    · facility_sources / facility_revisions
--        → SET NULL (수집 원본 · 변경 이력 = 감사기록. 링크만 끊고 본문 보존)
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 0. 마이그레이션 추적 (경량)
-- ---------------------------------------------------------------------
create table if not exists public.schema_migrations (
  version     text primary key,
  applied_at  timestamptz not null default now(),
  note        text
);

-- ---------------------------------------------------------------------
-- 1. feature_flags — 기능 스위치 (배포 없이 토글)
-- ---------------------------------------------------------------------
create table if not exists public.feature_flags (
  key         text primary key,
  enabled     boolean not null default false,
  description text,
  updated_at  timestamptz not null default now()
);

insert into public.feature_flags (key, enabled, description)
values ('hospital_module', false, '요양병원 모듈(검색 탭·필터·상세) 노출 스위치. OFF = 기존 요양원 화면과 완전 동일.')
on conflict (key) do nothing;   -- 이미 있으면 기존 값(OFF 여부) 유지

-- ---------------------------------------------------------------------
-- 2. facilities — additive 컬럼 3개 (+ 도메인 CHECK, + ykiho UNIQUE)
--    NOT NULL 은 이번 단계에서 적용하지 않음 (백필 검증 후 별도 migration).
-- ---------------------------------------------------------------------
alter table public.facilities add column if not exists domain     text;
alter table public.facilities add column if not exists source     text;
alter table public.facilities add column if not exists hira_ykiho text;

-- 기존 전체 데이터 = LTC 로 안전 백필 (DEFAULT 로도 채워지지만 명시적으로 한 번 더)
alter table public.facilities alter column domain set default 'LTC';
alter table public.facilities alter column source set default 'ltc_public';
update public.facilities set domain = 'LTC'        where domain is null;
update public.facilities set source = 'ltc_public' where source is null;

-- domain 허용값 제한 (전 행이 'LTC' 이므로 즉시 검증 통과)
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.facilities'::regclass and conname = 'facilities_domain_chk'
  ) then
    alter table public.facilities
      add constraint facilities_domain_chk check (domain in ('LTC','HOSPITAL'));
  end if;
end $$;

-- 요양병원 요양기호 중복 방지 (요양원 행은 hira_ykiho = NULL 이므로 영향 없음)
create unique index if not exists uq_facilities_hira_ykiho
  on public.facilities (hira_ykiho)
  where hira_ykiho is not null;

-- 도메인/지역 조합 조회용
create index if not exists idx_facilities_domain      on public.facilities (domain);
create index if not exists idx_facilities_domain_sido on public.facilities (domain, sido);

-- ---------------------------------------------------------------------
-- 3. hospital_profiles — 요양병원 전용 정보 (facilities 와 1:1)
--    전 컬럼 nullable. 의료서비스는 상태 enum 문자열로만.
-- ---------------------------------------------------------------------
create table if not exists public.hospital_profiles (
  facility_id        text primary key references public.facilities(id) on delete cascade,
  hira_ykiho         text,
  establishment_type text,                       -- 설립구분
  bed_total          integer,                    -- 총 병상 수
  bed_detail         jsonb,                      -- 병상 구분별 (일반/중환자/격리 등)
  specialties        text[],                     -- 진료과목
  specialist_counts  jsonb,                      -- 진료과목별 전문의 수
  equipment          jsonb,                      -- 의료장비
  homepage           text,
  -- 의료 특화 서비스: 각 값 = VERIFIED_TRUE | VERIFIED_FALSE | UNKNOWN | FACILITY_CLAIMED
  -- 데이터가 없다는 이유로 VERIFIED_FALSE 로 두지 않는다. 기본 UNKNOWN.
  medical_services   jsonb not null default '{}'::jsonb,
  last_verified_at   timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists idx_hospital_profiles_ykiho on public.hospital_profiles (hira_ykiho);

-- ---------------------------------------------------------------------
-- 4. facility_evaluations — 공식 평가 (요양원 A~E / 요양병원 적정성평가)
--    ⚠️ 두 평가를 같은 점수로 환산하지 않는다. grade_scale 로 체계를 구분.
--    ⚠️ 1A 에서 기존 facilities.eval_grade 는 그대로 둔다 (이관은 별도 단계).
-- ---------------------------------------------------------------------
create table if not exists public.facility_evaluations (
  id                    bigint generated always as identity primary key,
  facility_id           text not null references public.facilities(id) on delete cascade,
  evaluation_authority  text not null,           -- 'NHIS' | 'HIRA'
  evaluation_name       text not null,           -- '장기요양기관 정기평가' | '요양병원 적정성평가' ...
  evaluation_year       integer,
  grade                 text,                    -- 원문 등급 문자열 ('A'..'E' | '1'..'5' | ...)
  grade_scale           text,                    -- 'LTC_A_E' | 'HIRA_ADEQUACY' ... (환산 금지 표식)
  source_url            text,
  source_reference      text,
  source_date           date,                    -- 원본 기준일
  collected_at          timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  unique (facility_id, evaluation_authority, evaluation_name, evaluation_year)
);
create index if not exists idx_facility_evaluations_facility on public.facility_evaluations (facility_id);

-- ---------------------------------------------------------------------
-- 5. facility_sources — 수집 원본 추적 (fetch → raw 보관 → 정규화) · 감사기록
--    · unique(source_system, external_id): 서로 다른 제공처의 동일 external_id 충돌 방지.
--    · ON DELETE SET NULL: 시설이 (롤백 등으로) 물리 삭제돼도 원본 raw 기록은
--      보존하고 링크만 끊는다. 감사 목적상 CASCADE 로 함께 지우지 않는다.
-- ---------------------------------------------------------------------
create table if not exists public.facility_sources (
  id               bigint generated always as identity primary key,
  facility_id      text references public.facilities(id) on delete set null,  -- 매칭 전/삭제 후엔 NULL
  source_system    text not null,                -- 'hira_hospital_info' | 'hira_hospital_eval' | 'ltc_public_list' ...
  dataset_id       text,                         -- data.go.kr 서비스/데이터셋 식별자
  external_id      text,                         -- 원본 기관 식별자 (심평원 요양기호 원문)
  raw              jsonb not null,
  source_date      date,
  fetched_at       timestamptz not null default now(),
  normalized_hash  text,
  verified_at      timestamptz,
  constraint uq_facility_sources_system_extid unique (source_system, external_id)
);
create index if not exists idx_facility_sources_facility on public.facility_sources (facility_id);

-- ---------------------------------------------------------------------
-- 6. facility_revisions — 필드 변경 이력 (파이프라인 vs 운영자 수정 구분) · 감사기록
--    · 공공데이터 재수집이 운영자 검수값을 무조건 덮어쓰지 않기 위한 근거.
--    · ON DELETE SET NULL + facility_id NULL 허용: 시설 물리 삭제 시에도
--      변경 이력 본문(field / old_value / new_value / changed_by / created_at)은 보존.
-- ---------------------------------------------------------------------
create table if not exists public.facility_revisions (
  id             bigint generated always as identity primary key,
  facility_id    text references public.facilities(id) on delete set null,
  field          text not null,
  old_value      text,
  new_value      text,
  changed_by     text not null,                  -- 'pipeline:hira_ingest' | 'admin' ...
  change_reason  text,
  created_at     timestamptz not null default now()
);
create index if not exists idx_facility_revisions_facility on public.facility_revisions (facility_id, created_at desc);

-- ---------------------------------------------------------------------
-- 7. facility_duplicate_candidates — 교차 중복 "의심"만 기록 (자동 병합 금지)
-- ---------------------------------------------------------------------
create table if not exists public.facility_duplicate_candidates (
  id             bigint generated always as identity primary key,
  facility_id_a  text not null references public.facilities(id) on delete cascade,
  facility_id_b  text not null references public.facilities(id) on delete cascade,
  match_reason   text,                           -- 'name+addr' | 'name+phone' | 'addr+geo' ...
  similarity     numeric,
  status         text not null default 'pending',-- pending / same / different / linked
  reviewed_by    text,
  reviewed_at    timestamptz,
  note           text,
  created_at     timestamptz not null default now(),
  constraint fdc_pair_ordered check (facility_id_a < facility_id_b),
  unique (facility_id_a, facility_id_b)
);
create index if not exists idx_fdc_status on public.facility_duplicate_candidates (status);

-- ---------------------------------------------------------------------
-- 8. ingestion_runs — 수집 실행 로그 (신규/변경/폐업/오류 카운트)
-- ---------------------------------------------------------------------
create table if not exists public.ingestion_runs (
  id             bigint generated always as identity primary key,
  job            text not null,                  -- 'hira_hospital_ingest' | 'hira_hospital_eval' ...
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  status         text not null default 'running',-- running / ok / partial / failed
  count_new      integer not null default 0,
  count_updated  integer not null default 0,
  count_closed   integer not null default 0,
  count_error    integer not null default 0,
  detail         jsonb
);
create index if not exists idx_ingestion_runs_job on public.ingestion_runs (job, started_at desc);

-- ---------------------------------------------------------------------
-- 9. RLS — 신규 테이블도 기존 패턴과 동일: enable + 정책 0개 (service_role 전용)
-- ---------------------------------------------------------------------
alter table public.schema_migrations             enable row level security;
alter table public.feature_flags                 enable row level security;
alter table public.hospital_profiles             enable row level security;
alter table public.facility_evaluations          enable row level security;
alter table public.facility_sources              enable row level security;
alter table public.facility_revisions            enable row level security;
alter table public.facility_duplicate_candidates enable row level security;
alter table public.ingestion_runs                enable row level security;

-- ---------------------------------------------------------------------
-- 10. 기록
-- ---------------------------------------------------------------------
insert into public.schema_migrations (version, note)
values ('001_hospital_module', '요양병원 기반 스키마: feature_flags, facilities +domain/source/hira_ykiho (LTC 백필), hospital_profiles, facility_evaluations, facility_sources, facility_revisions, facility_duplicate_candidates, ingestion_runs')
on conflict (version) do nothing;

commit;

-- =====================================================================
-- 실행 후 확인 (README.md 참고):
--   select count(*) from public.facilities;                       -- 기존과 동일
--   select count(*) from public.facilities where domain = 'LTC';  -- 위와 동일
--   select count(*) from public.facilities where domain is null;  -- 0
--   select count(*) from public.facilities where domain = 'HOSPITAL'; -- 0
--   select key, enabled from public.feature_flags;                -- hospital_module | f
-- =====================================================================
