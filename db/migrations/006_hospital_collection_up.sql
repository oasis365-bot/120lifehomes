-- =====================================================================
-- Migration 006 — 전국 요양병원 수집 checkpoint/lease/일일 쿼터 스키마 (1B-5B)
-- 방향: UP (적용)
-- =====================================================================
--  전제:
--   · 005_preflight.sql 로 이름 충돌·기존 객체 없음을 먼저 확인했다.
--   · 이 migration 은 ADDITIVE 전용이다.
--       - 기존 테이블·컬럼·데이터 변경 없음 (001/002 및 facilities/LTC 스키마 무손상)
--       - 신규 테이블 3개 + 신규 함수 4개만 생성
--   · 이 단계는 스키마·함수만 구현한다. 배치 API·GitHub Actions·HIRA 실호출은
--     별도 작업(1B-5C 이후)이다. 이 migration 자체는 어떤 실제 데이터도 쓰지 않는다
--     (feature_flags 시드 삽입 같은 것도 없음 — 순수 DDL/함수 정의).
--
--  실행: Supabase SQL Editor 에 이 파일 전체를 붙여넣고 1회 실행.
--        (자동 번역 끄기 · 실행 후 007_verify.sql 확인)
--
--  재실행 안전: 신규 테이블이므로 CHECK/UNIQUE 를 CREATE TABLE 내부에 인라인으로
--    선언한다(001 의 facilities_domain_chk 처럼 ALTER TABLE 로 별도 추가하는 것은
--    "기존 테이블에 나중에 붙이는 경우"에만 필요 — 이번엔 전부 신규 테이블이라
--    CREATE TABLE IF NOT EXISTS 자체가 통째로 idempotent 하다).
--    함수는 CREATE OR REPLACE FUNCTION, 인덱스는 CREATE [UNIQUE] INDEX IF NOT EXISTS,
--    GRANT/REVOKE·RLS ENABLE 은 전부 Postgres 자체가 idempotent.
--
--  facility_id FK 비연결 근거(요약 — 상세는 PR/보고 참고):
--    hospital_collection_items.facility_id 는 의도적으로 public.facilities(id) 를
--    참조하지 않는다. discovery 시점엔 아직 상세(enrichment) 를 하지 않아
--    facilities.name(NOT NULL) 등을 채울 근거 데이터가 없고, FK 를 걸면
--    discovery 가 강제로 "불완전한 facilities stub row" 를 즉시 만들어야 하는데
--    그 stub 이 공개 검색/상세 API(GET /api/hospital/facilities·facility)가 읽는
--    바로 그 테이블에 섞여 노출 위험을 만든다. 이 결합 여부는 enrichment 설계와
--    공개 노출 정책이 정해진 뒤 별도 migration 에서 재검토한다.
--    대신 형식만 가벼운 CHECK 로 고정(아래 *_facility_id_format_chk 참고).
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. hospital_collection_jobs — 전국 수집 작업의 헤더 · checkpoint · lease
-- ---------------------------------------------------------------------
--  status 전이(운영 의미):
--    pending            아직 시작 안 함(생성 직후)
--    running            현재 lease 를 쥔 실행이 진행 중
--    paused_for_today   일일 HIRA 호출 상한 도달 등으로 정상 중단, 다음날 재개 대상
--    completed          discovery+enrichment 모두 끝난 정상 종료(터미널)
--    failed             복구 불가 오류로 중단(터미널)
--    cancelled          운영자가 명시적으로 취소(터미널)
--  "활성" 정의(아래 partial unique index 근거) = pending/running/paused_for_today.
--    완료/실패/취소는 터미널 상태이므로 같은 job 종류로 새 작업을 다시 만들 수 있어야 함.
--  phase: discovery(목록 수집 중) → enrichment(기관별 상세 수집 중) → done(둘 다 종료).
create table if not exists public.hospital_collection_jobs (
  id                     uuid primary key default gen_random_uuid(),
  job                    text not null,                       -- 예: 'hira_hospital_nationwide' (자유 텍스트, ingestion_runs.job 과 동일 관례)
  status                 text not null default 'pending',
  phase                  text not null default 'discovery',

  -- discovery checkpoint: 마지막으로 "완료 처리"한 목록 페이지 번호. 0 = 아직 없음.
  discovery_page         integer not null default 0,
  -- snapshot 이 확정되면(더 이상 discovery 로 목록이 바뀌지 않음) 시각·총건수 기록.
  snapshot_completed_at  timestamptz,
  snapshot_total_count   integer,

  count_processed        integer not null default 0,
  count_new              integer not null default 0,
  count_updated          integer not null default 0,
  count_unchanged        integer not null default 0,
  count_partial          integer not null default 0,
  count_failed           integer not null default 0,
  count_dead_letter      integer not null default 0,

  -- lease: 동시에 두 실행이 같은 job 을 진행하지 못하게 하는 원자적 소유권.
  --   lease_owner IS NULL 이거나 lease_expires_at < now() 이면 "회수 가능".
  lease_owner            text,
  lease_expires_at       timestamptz,
  heartbeat_at           timestamptz,

  -- 안전한 allowlist 오류 코드만(원문 메시지·URL·기관정보 절대 금지). 예: 'deadline_exceeded'.
  last_error_code        text,

  started_at             timestamptz,
  finished_at            timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint hospital_collection_jobs_status_chk
    check (status in ('pending','running','paused_for_today','completed','failed','cancelled')),
  constraint hospital_collection_jobs_phase_chk
    check (phase in ('discovery','enrichment','done')),
  constraint hospital_collection_jobs_discovery_page_chk
    check (discovery_page >= 0),
  constraint hospital_collection_jobs_snapshot_total_chk
    check (snapshot_total_count is null or snapshot_total_count >= 0),
  constraint hospital_collection_jobs_counts_nonneg_chk
    check (
      count_processed   >= 0 and count_new     >= 0 and count_updated >= 0 and
      count_unchanged   >= 0 and count_partial >= 0 and count_failed  >= 0 and
      count_dead_letter >= 0
    )
);

-- 같은 job 종류에서 "활성"(터미널이 아닌) 작업이 동시에 여러 개 생기지 않도록.
-- 완료/실패/취소된 이전 작업은 이 인덱스 범위 밖이라 같은 job 이름으로 재생성 가능.
create unique index if not exists uq_hospital_collection_jobs_active_per_job
  on public.hospital_collection_jobs (job)
  where status in ('pending','running','paused_for_today');

create index if not exists idx_hospital_collection_jobs_job_status
  on public.hospital_collection_jobs (job, status);

-- 만료된 lease 를 스캔해 회수 대상 찾을 때 사용.
create index if not exists idx_hospital_collection_jobs_lease_expires
  on public.hospital_collection_jobs (lease_expires_at)
  where lease_owner is not null;

-- ---------------------------------------------------------------------
-- 2. hospital_collection_items — discovery snapshot 의 기관별 처리 상태
-- ---------------------------------------------------------------------
--  facility_id: 기존 결정론적 공개 식별자("H-"+ykiho, lib/hira/adapter.js 의
--    hospitalIdFromYkiho 결과)만 저장. ykiho 원문 별도 컬럼·기관명·주소·전화·
--    HIRA URL·raw 응답·raw 오류·Supabase 자격증명은 이 테이블에 저장하지 않는다.
--    facilities(id) FK 는 의도적으로 걸지 않음 — 근거는 파일 상단 주석 참고.
create table if not exists public.hospital_collection_items (
  id               uuid primary key default gen_random_uuid(),
  job_id           uuid not null references public.hospital_collection_jobs(id) on delete cascade,
  ordinal          integer not null,
  facility_id      text not null,

  status           text not null default 'pending',
  attempt_count    integer not null default 0,
  -- 안전한 allowlist 오류 코드만(예: 'http_5xx','timeout'). 원문 오류 금지.
  last_error_code  text,
  next_retry_at    timestamptz,

  started_at       timestamptz,
  completed_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint hospital_collection_items_status_chk
    check (status in ('pending','processing','retry_wait','completed','dead_letter')),
  constraint hospital_collection_items_attempt_count_chk
    check (attempt_count >= 0),
  constraint hospital_collection_items_ordinal_chk
    check (ordinal >= 0),
  -- 형식만 가벼운 CHECK 로 고정(FK 대체 아님) — "H-" 로 시작하는 결정론적 id 만 허용.
  constraint hospital_collection_items_facility_id_format_chk
    check (facility_id like 'H-%'),
  constraint uq_hospital_collection_items_job_facility unique (job_id, facility_id),
  constraint uq_hospital_collection_items_job_ordinal  unique (job_id, ordinal)
);

create index if not exists idx_hospital_collection_items_job_status_ordinal
  on public.hospital_collection_items (job_id, status, ordinal);

-- ---------------------------------------------------------------------
-- 3. hospital_hira_daily_usage — KST 날짜별 HIRA 호출 하드캡 전용
-- ---------------------------------------------------------------------
--  usage_date 는 항상 DB 서버에서 Asia/Seoul 기준으로 계산해 넣는다
--  (hospital_hira_reserve_daily_calls 함수만 이 테이블에 쓴다 — 호출자가
--  전달한 날짜를 신뢰하지 않음).
--  completed_calls 는 관측용 예약 컬럼이다. 이번 단계에서는 어떤 함수도
--  이 컬럼에 쓰지 않는다(집계 전용, 상한 판정과 무관) — 필요해지면 별도 함수로 추가.
create table if not exists public.hospital_hira_daily_usage (
  usage_date       date primary key,
  reserved_calls   integer not null default 0,
  completed_calls  integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint hospital_hira_daily_usage_reserved_nonneg_chk  check (reserved_calls  >= 0),
  constraint hospital_hira_daily_usage_completed_nonneg_chk check (completed_calls >= 0)
);

-- ---------------------------------------------------------------------
-- 4. RLS — 신규 테이블도 기존 패턴과 동일: enable + 정책 0개 (service_role 전용)
-- ---------------------------------------------------------------------
alter table public.hospital_collection_jobs   enable row level security;
alter table public.hospital_collection_items  enable row level security;
alter table public.hospital_hira_daily_usage  enable row level security;

-- ---------------------------------------------------------------------
-- 5. 원자적 DB 함수 — 클라이언트 SELECT→UPDATE 금지, 전부 단일 트랜잭션 함수로.
--    공통: SECURITY DEFINER + 고정 search_path(스키마 탈취 방지) + 동적 SQL 없음 +
--    입력 검증 후 예외 발생 + PUBLIC/anon/authenticated execute 금지, service_role 만 허용.
-- ---------------------------------------------------------------------

-- 5-1. lease 획득: lease 가 없거나 만료된 경우에만 원자적으로 owner·만료시각 설정.
--   반환: true = 획득 성공, false = 이미 다른 owner 가 살아있는 lease 를 쥐고 있거나
--         job_id 가 존재하지 않음.
create or replace function public.hospital_collection_job_acquire_lease(
  p_job_id uuid,
  p_owner text,
  p_lease_seconds integer default 90
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows integer;
begin
  if p_job_id is null then
    raise exception 'invalid_job_id' using errcode = '22023';
  end if;
  if p_owner is null or length(btrim(p_owner)) = 0 then
    raise exception 'invalid_owner' using errcode = '22023';
  end if;
  if p_lease_seconds is null or p_lease_seconds <= 0 or p_lease_seconds > 3600 then
    raise exception 'invalid_lease_seconds' using errcode = '22023';
  end if;

  update public.hospital_collection_jobs
     set lease_owner      = p_owner,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         heartbeat_at     = now(),
         updated_at       = now()
   where id = p_job_id
     and (lease_owner is null or lease_expires_at is null or lease_expires_at < now());

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

-- 5-2. heartbeat/lease 연장: 현재 owner 가 정확히 일치할 때만 성공.
--   다른(또는 만료 후 새로 발급된) owner 의 lease 는 절대 연장하지 못한다.
create or replace function public.hospital_collection_job_heartbeat(
  p_job_id uuid,
  p_owner text,
  p_lease_seconds integer default 90
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows integer;
begin
  if p_job_id is null then
    raise exception 'invalid_job_id' using errcode = '22023';
  end if;
  if p_owner is null or length(btrim(p_owner)) = 0 then
    raise exception 'invalid_owner' using errcode = '22023';
  end if;
  if p_lease_seconds is null or p_lease_seconds <= 0 or p_lease_seconds > 3600 then
    raise exception 'invalid_lease_seconds' using errcode = '22023';
  end if;

  update public.hospital_collection_jobs
     set lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         heartbeat_at     = now(),
         updated_at       = now()
   where id = p_job_id
     and lease_owner = p_owner;

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

-- 5-3. lease 해제: 현재 owner 가 정확히 일치할 때만 성공. p_next_status 를 같이
--   넘기면 lease 해제와 상태 전이를 하나의 원자적 UPDATE 로 처리해, 별도 두 번째
--   호출로 인한 경합(해제 직후 다른 실행이 lease 를 채가는 사이 상태만 못 바뀌는
--   경우 등)을 원천적으로 없앤다.
create or replace function public.hospital_collection_job_release_lease(
  p_job_id uuid,
  p_owner text,
  p_next_status text default null
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows integer;
begin
  if p_job_id is null then
    raise exception 'invalid_job_id' using errcode = '22023';
  end if;
  if p_owner is null or length(btrim(p_owner)) = 0 then
    raise exception 'invalid_owner' using errcode = '22023';
  end if;
  if p_next_status is not null
     and p_next_status not in ('pending','running','paused_for_today','completed','failed','cancelled') then
    raise exception 'invalid_next_status' using errcode = '22023';
  end if;

  update public.hospital_collection_jobs
     set lease_owner      = null,
         lease_expires_at = null,
         status           = coalesce(p_next_status, status),
         finished_at      = case when p_next_status in ('completed','failed','cancelled')
                                  then now() else finished_at end,
         updated_at       = now()
   where id = p_job_id
     and lease_owner = p_owner;

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

-- 5-4. KST 일일 HIRA 호출 예약: HTTP 요청 "직전" 호출. 강제종료돼도 이미 커밋된
--   예약은 되돌리지 않는다 → 실제 성공한 호출 수보다 같거나 많게(과대 집계) 기록되는
--   fail-safe 방향. p_requested_cap 을 애플리케이션이 얼마를 넘기든, DB 함수 자체가
--   절대 상한 2,000 을 강제한다(least 로 클램프). 원자성은 단일 UPDATE 문의
--   행 잠금으로 보장 — "현재 값 조회 후 별도 UPDATE" 를 하지 않으므로 동시 호출
--   두 개가 마지막 남은 quota 를 동시에 소비할 수 없다.
create or replace function public.hospital_hira_reserve_daily_calls(
  p_calls integer,
  p_requested_cap integer default 1000
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hard_cap constant integer := 2000;
  v_effective_cap integer;
  v_today date;
  v_rows integer;
begin
  if p_calls is null or p_calls <= 0 or p_calls > v_hard_cap then
    raise exception 'invalid_call_count' using errcode = '22023';
  end if;
  if p_requested_cap is null or p_requested_cap <= 0 then
    raise exception 'invalid_requested_cap' using errcode = '22023';
  end if;

  v_effective_cap := least(p_requested_cap, v_hard_cap);
  v_today := (now() at time zone 'Asia/Seoul')::date;

  insert into public.hospital_hira_daily_usage (usage_date, reserved_calls)
  values (v_today, 0)
  on conflict (usage_date) do nothing;

  update public.hospital_hira_daily_usage
     set reserved_calls = reserved_calls + p_calls,
         updated_at     = now()
   where usage_date = v_today
     and reserved_calls + p_calls <= v_effective_cap;

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

-- ---------------------------------------------------------------------
-- 6. 함수 권한 — service_role 전용 (PUBLIC 은 함수 생성 시 기본으로 EXECUTE 를
--    받으므로 명시적으로 회수해야 한다. anon/authenticated 는 애초에 부여한 적
--    없지만 방어적으로 함께 회수한다.)
-- ---------------------------------------------------------------------
revoke all on function public.hospital_collection_job_acquire_lease(uuid, text, integer)  from public, anon, authenticated;
revoke all on function public.hospital_collection_job_heartbeat(uuid, text, integer)      from public, anon, authenticated;
revoke all on function public.hospital_collection_job_release_lease(uuid, text, text)     from public, anon, authenticated;
revoke all on function public.hospital_hira_reserve_daily_calls(integer, integer)         from public, anon, authenticated;

grant execute on function public.hospital_collection_job_acquire_lease(uuid, text, integer)  to service_role;
grant execute on function public.hospital_collection_job_heartbeat(uuid, text, integer)      to service_role;
grant execute on function public.hospital_collection_job_release_lease(uuid, text, text)     to service_role;
grant execute on function public.hospital_hira_reserve_daily_calls(integer, integer)         to service_role;

-- ---------------------------------------------------------------------
-- 7. 기록
-- ---------------------------------------------------------------------
insert into public.schema_migrations (version, note)
values ('006_hospital_collection', '전국 요양병원 수집 checkpoint/lease/일일 쿼터 스키마: hospital_collection_jobs, hospital_collection_items, hospital_hira_daily_usage + 원자적 lease/quota 함수 4개. 배치 API·HIRA 호출은 포함 안 함(1B-5B).')
on conflict (version) do nothing;

commit;

-- =====================================================================
-- 실행 후 확인 (007_verify.sql 참고):
--   select count(*) from public.hospital_collection_jobs;   -- 0 (이 migration 은 데이터를 넣지 않음)
--   select count(*) from public.hospital_collection_items;  -- 0
--   select count(*) from public.hospital_hira_daily_usage;  -- 0
-- =====================================================================
