// 1B-5B — 전국 요양병원 수집 checkpoint/lease/일일 쿼터 스키마 (005/006/007) 정적 검증.
//   ⚠️ 실제 PostgreSQL/Supabase 연결 없음. migration SQL 텍스트만 정적으로 검사한다.
//   실제 DB 적용은 이 저장소 CI 범위 밖(Preview/Production 승인 후 수동 실행).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => readFileSync(root + p, 'utf8');
const migDir = () => readdirSync(root + 'db/migrations');

const UP = 'db/migrations/006_hospital_collection_up.sql';
const DOWN = 'db/migrations/006_hospital_collection_down.sql';
const PREFLIGHT = 'db/migrations/005_preflight.sql';
const VERIFY = 'db/migrations/007_verify.sql';

test('005/006/007: 기존 migration 번호와 충돌 없음 (003/004 는 여전히 미생성 · 재사용 안 함)', () => {
  const files = migDir();
  assert.ok(files.includes('005_preflight.sql'));
  assert.ok(files.includes('006_hospital_collection_up.sql'));
  assert.ok(files.includes('006_hospital_collection_down.sql'));
  assert.ok(files.includes('007_verify.sql'));
  // 003/004 는 README 에 다른 목적(도메인 NOT NULL 확정 / 1B 필드 보강)으로
  // 예약돼 있음 — 이번 작업이 그 번호를 만들거나 건드리지 않았는지 확인.
  assert.equal(files.some((f) => f.startsWith('003')), false, '003_* 파일이 생성됨(예약 번호 침범)');
  assert.equal(files.some((f) => f.startsWith('004')), false, '004_* 파일이 생성됨(예약 번호 침범)');
  // 기존 000/001/002 는 그대로 존재해야 함(수정 금지 확인의 일부)
  assert.ok(files.includes('000_preflight.sql'));
  assert.ok(files.includes('001_hospital_module_up.sql'));
  assert.ok(files.includes('001_hospital_module_down.sql'));
  assert.ok(files.includes('002_verify.sql'));
});

test('기존 000/001/002 migration 파일은 이 작업에서 내용이 바뀌지 않음(정적 시그니처 확인)', () => {
  // 실제 diff 는 git 으로 별도 확인하지만, 핵심 시그니처가 그대로인지 정적으로도 고정.
  const up001 = read('db/migrations/001_hospital_module_up.sql');
  assert.ok(up001.includes("insert into public.schema_migrations (version, note)\nvalues ('001_hospital_module'"));
  const verify002 = read('db/migrations/002_verify.sql');
  assert.ok(verify002.includes('C7 신규 테이블 생성 수 (기대 8)'));
});

test('006 up: 신규 테이블 3개 정의', () => {
  const src = read(UP);
  assert.ok(src.includes('create table if not exists public.hospital_collection_jobs'));
  assert.ok(src.includes('create table if not exists public.hospital_collection_items'));
  assert.ok(src.includes('create table if not exists public.hospital_hira_daily_usage'));
});

test('006 up: hospital_collection_jobs 필수 CHECK/인덱스 존재', () => {
  const src = read(UP);
  for (const name of [
    'hospital_collection_jobs_status_chk',
    'hospital_collection_jobs_phase_chk',
    'hospital_collection_jobs_discovery_page_chk',
    'hospital_collection_jobs_snapshot_total_chk',
    'hospital_collection_jobs_counts_nonneg_chk',
    'hospital_collection_jobs_job_chk',
    'hospital_collection_jobs_lease_owner_len_chk',
    'hospital_collection_jobs_last_error_code_fmt_chk',
    'uq_hospital_collection_jobs_active_per_job',
    'idx_hospital_collection_jobs_job_status',
    'idx_hospital_collection_jobs_lease_expires',
  ]) {
    assert.ok(src.includes(name), `${name} 없음`);
  }
  // status/phase 허용값 목록이 요구된 값과 정확히 일치
  assert.match(src, /status in \('pending','running','paused_for_today','completed','failed','cancelled'\)/);
  assert.match(src, /phase in \('discovery','enrichment','done'\)/);
});

test('006 up: job 은 free text 가 아니라 allowlist CHECK 로 고정됨(partial unique 우회 방지)', () => {
  const src = read(UP);
  const at = src.indexOf('constraint hospital_collection_jobs_job_chk');
  assert.ok(at > 0);
  const block = src.slice(at, src.indexOf(',', at) + 1);
  assert.match(block, /check \(job in \('hira_hospital_nationwide'\)\)/);
});

test('006 up: lease_owner(jobs) 는 길이 상한 CHECK 를 가짐', () => {
  const src = read(UP);
  assert.ok(src.includes('char_length(lease_owner) between 1 and 128'));
});

test('006 up: last_error_code 계약 — DB 는 slug 형식만 강제, "정확한 allowlist" 라고 표현하지 않음', () => {
  const src = read(UP);
  // 코드 CHECK 자체는 정규식 형식만(길이만 재는 예전 계약으로 되돌아가지 않았는지 확인).
  const jobsChk = "check (last_error_code is null or last_error_code ~ '^[a-z0-9_]{1,64}$')";
  const itemsChk = "check (last_error_code is null or last_error_code ~ '^[a-z0-9_]{1,64}$')";
  assert.ok(src.includes(jobsChk), 'jobs last_error_code 가 slug 정규식 CHECK 아님');
  assert.ok(src.includes(itemsChk), 'items last_error_code 가 slug 정규식 CHECK 아님');
  // "DB 가 정확한 오류 코드 allowlist 를 구현한다" 는 잘못된 옛 표현이 없어야 함.
  // (job 종류 allowlist — 실제로 DB CHECK 로 구현됨 — 는 별개이며 정당한 표현이므로 허용.)
  assert.equal(/안전한 allowlist 오류 코드만/.test(src), false, '오류 코드 자체를 DB allowlist 라고 잘못 표기한 옛 문구가 남아있음');
  // "정확한 ... allowlist 는 ... DB ... 범위 밖/책임" 처럼 DB 가 아니라 애플리케이션 책임임을
  // 명시하는 문구가 last_error_code 근처에 있어야 함(오표기 방지 확인의 반대쪽 확인).
  assert.ok(/allowlist[^\n]*(범위 밖|애플리케이션|후속 배치)/.test(src) || /(애플리케이션|후속 배치)[^\n]*allowlist/.test(src),
    'last_error_code 의 정확한 allowlist 는 애플리케이션 계층 책임이라는 명시가 없음');
});

test('last_error_code 정규식(실제 migration 문자열에서 추출)이 요구된 값들을 정확히 거부/허용함', () => {
  const src = read(UP);
  // SQL 소스에서 실제 정규식 리터럴을 그대로 추출해 JS RegExp 로 재현 — SQL 을 하드코딩
  // 재작성하지 않고 "진짜 migration 에 들어있는 패턴"을 검증한다.
  const m = src.match(/last_error_code ~ '(\^\[a-z0-9_\]\{1,64\}\$)'/);
  assert.ok(m, '정규식 리터럴을 소스에서 찾지 못함');
  const re = new RegExp(m[1]);

  const rejected = [
    ' ',                       // 공백
    'DEADLINE_EXCEEDED',       // 대문자
    'http-429',                // 하이픈
    'https://example.com',     // URL
    'deadline_exceeded\nmore', // 줄바꿈
    'a'.repeat(65),            // 65자 이상
    '수집 중 알 수 없는 오류가 발생했습니다', // raw 오류 문장
  ];
  for (const v of rejected) {
    assert.equal(re.test(v), false, `거부돼야 하는데 통과함: ${JSON.stringify(v)}`);
  }

  const accepted = ['deadline_exceeded', 'http_429', 'quota_exhausted'];
  for (const v of accepted) {
    assert.ok(re.test(v), `허용돼야 하는데 거부됨: ${JSON.stringify(v)}`);
  }
});

test('006 up: 활성-작업 partial unique index 는 정확히 pending/running/paused_for_today 범위(터미널 상태 제외)', () => {
  const src = read(UP);
  const at = src.indexOf('uq_hospital_collection_jobs_active_per_job');
  assert.ok(at > 0);
  const block = src.slice(at, src.indexOf(';', at) + 1);
  assert.ok(block.includes("where status in ('pending','running','paused_for_today')"));
  assert.equal(/completed|failed|cancelled/.test(block), false, '터미널 상태가 활성 범위에 포함됨');
});

test('006 up: hospital_collection_items 필수 CHECK/UNIQUE/인덱스 존재', () => {
  const src = read(UP);
  for (const name of [
    'hospital_collection_items_status_chk',
    'hospital_collection_items_attempt_count_chk',
    'hospital_collection_items_ordinal_chk',
    'hospital_collection_items_facility_id_format_chk',
    'hospital_collection_items_facility_id_len_chk',
    'hospital_collection_items_last_error_code_fmt_chk',
    'uq_hospital_collection_items_job_facility',
    'uq_hospital_collection_items_job_ordinal',
    'idx_hospital_collection_items_job_status_ordinal',
  ]) {
    assert.ok(src.includes(name), `${name} 없음`);
  }
  assert.match(src, /status in \('pending','processing','retry_wait','completed','dead_letter'\)/);
  assert.ok(src.includes('unique (job_id, facility_id)'));
  assert.ok(src.includes('unique (job_id, ordinal)'));
  assert.ok(src.includes('char_length(facility_id) between 3 and 200'));
});

test('006 up: hospital_collection_items 는 facilities FK 를 걸지 않음(의도적 비연결)', () => {
  const src = read(UP);
  const at = src.indexOf('create table if not exists public.hospital_collection_items');
  const block = src.slice(at, src.indexOf(');', at) + 2);
  assert.equal(/references\s+public\.facilities/i.test(block), false, 'facilities FK 가 걸려 있음');
  // job_id → hospital_collection_jobs FK 는 있어야 함(같은 job 내 정합성)
  assert.ok(/references\s+public\.hospital_collection_jobs/i.test(block));
});

test('006 up: hospital_collection_items 에 ykiho 원문·기관명·주소·전화·URL·raw·비밀 컬럼 없음(allowlist 컬럼만)', () => {
  const src = read(UP);
  const at = src.indexOf('create table if not exists public.hospital_collection_items');
  // -- 주석은 설명상 금지 키워드를 언급할 수 있으므로(예: "URL 절대 금지") 제외하고,
  // 실제 컬럼/타입 정의에만 금지 키워드가 없는지 확인한다.
  const block = src.slice(at, src.indexOf(');', at) + 2).replace(/--[^\n]*/g, '').toLowerCase();
  const forbidden = ['ykiho', 'yadm', 'addr', 'phone', 'telno', 'url', 'raw', 'secret', 'servicekey', 'apikey', 'token'];
  for (const kw of forbidden) {
    assert.equal(block.includes(kw), false, `금지 키워드 "${kw}" 가 hospital_collection_items 실제 정의(주석 제외)에 존재`);
  }
  const allowedCols = [
    'id', 'job_id', 'ordinal', 'facility_id', 'status', 'attempt_count',
    'last_error_code', 'next_retry_at', 'started_at', 'completed_at', 'created_at', 'updated_at',
  ];
  assert.ok(allowedCols.every((c) => block.includes(c)));
});

test('006 up: hospital_collection_jobs 에도 ykiho·기관명·raw·비밀 컬럼 없음', () => {
  const src = read(UP);
  const at = src.indexOf('create table if not exists public.hospital_collection_jobs');
  const block = src.slice(at, src.indexOf('-- 같은 job 종류에서', at)).replace(/--[^\n]*/g, '').toLowerCase();
  const forbidden = ['ykiho', 'yadm', 'addr', 'phone', 'telno', 'url', 'raw', 'secret', 'servicekey', 'apikey', 'token'];
  for (const kw of forbidden) {
    assert.equal(block.includes(kw), false, `금지 키워드 "${kw}" 가 hospital_collection_jobs 실제 정의(주석 제외)에 존재`);
  }
});

test('006 up: hospital_hira_daily_usage 필수 CHECK 존재 및 usage_date 는 date PK', () => {
  const src = read(UP);
  assert.ok(src.includes('hospital_hira_daily_usage_reserved_nonneg_chk'));
  assert.ok(src.includes('hospital_hira_daily_usage_completed_nonneg_chk'));
  assert.ok(src.includes('usage_date       date primary key'));
});

test('006 up: 모든 CHECK 카운트 열은 0 이상 제약', () => {
  const src = read(UP);
  assert.ok(src.includes('count_processed   >= 0'));
  assert.ok(src.includes('reserved_calls  >= 0'));
  assert.ok(src.includes('completed_calls >= 0'));
  assert.ok(src.includes('attempt_count >= 0'));
});

test('006 up: RLS enable 3개 + 공개 policy 0개(create policy 문 없음)', () => {
  const src = read(UP);
  assert.ok(src.includes('alter table public.hospital_collection_jobs   enable row level security'));
  assert.ok(src.includes('alter table public.hospital_collection_items  enable row level security'));
  assert.ok(src.includes('alter table public.hospital_hira_daily_usage  enable row level security'));
  assert.equal(/create\s+policy/i.test(src), false, 'create policy 문이 존재함(RLS 정책 0개 원칙 위반)');
});

test('006 up: 신규 함수 4개 전부 SECURITY DEFINER + 고정 search_path + 동적 SQL 없음', () => {
  const src = read(UP);
  const fns = [
    'hospital_collection_job_acquire_lease',
    'hospital_collection_job_heartbeat',
    'hospital_collection_job_release_lease',
    'hospital_hira_reserve_daily_calls',
  ];
  for (const fn of fns) {
    const at = src.indexOf(`create or replace function public.${fn}(`);
    assert.ok(at > 0, `${fn} 정의 없음`);
    const bodyEnd = src.indexOf('\n$$;', at);
    const block = src.slice(at, bodyEnd);
    assert.ok(block.includes('security definer'), `${fn} 에 security definer 없음`);
    assert.ok(block.includes('set search_path = public, pg_temp'), `${fn} 에 고정 search_path 없음`);
    assert.equal(/\bexecute\b\s+['"$]/i.test(block), false, `${fn} 에 동적 SQL(EXECUTE) 사용`);
  }
});

test('006 up: 함수 권한 — public/anon/authenticated revoke, service_role 만 grant', () => {
  const src = read(UP);
  const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fnSigs = [
    'hospital_collection_job_acquire_lease(uuid, text, integer)',
    'hospital_collection_job_heartbeat(uuid, text, integer)',
    'hospital_collection_job_release_lease(uuid, text, text)',
    'hospital_hira_reserve_daily_calls(integer, integer)',
  ];
  for (const sig of fnSigs) {
    const esc = escapeRegex(sig);
    assert.match(src, new RegExp(`revoke all on function public\\.${esc}\\s+from public, anon, authenticated`),
      `${sig} revoke 누락`);
    assert.match(src, new RegExp(`grant execute on function public\\.${esc}\\s+to service_role`),
      `${sig} service_role grant 누락`);
  }
});

test('acquire_lease: 만료되지 않은(살아있는) 다른 owner 의 lease 는 탈취 조건에서 제외됨', () => {
  const src = read(UP);
  const at = src.indexOf('create or replace function public.hospital_collection_job_acquire_lease(');
  const block = src.slice(at, src.indexOf('\n$$;', at));
  assert.ok(block.includes('lease_owner is null or lease_expires_at is null or lease_expires_at < now()'));
});

test('lease 함수 3개 전부 p_owner 길이 상한(128) 검증(테이블 CHECK 와 일치)', () => {
  const src = read(UP);
  for (const fn of [
    'hospital_collection_job_acquire_lease',
    'hospital_collection_job_heartbeat',
    'hospital_collection_job_release_lease',
  ]) {
    const at = src.indexOf(`create or replace function public.${fn}(`);
    const block = src.slice(at, src.indexOf('\n$$;', at));
    assert.ok(block.includes('length(p_owner) > 128'), `${fn} 에 owner 길이 상한 검증 없음`);
  }
});

test('heartbeat/release: 현재 owner 일치 조건이 WHERE 절에 있음(임의 owner 가 남의 lease 조작 불가)', () => {
  const src = read(UP);
  for (const fn of ['hospital_collection_job_heartbeat', 'hospital_collection_job_release_lease']) {
    const at = src.indexOf(`create or replace function public.${fn}(`);
    const block = src.slice(at, src.indexOf('\n$$;', at));
    assert.ok(block.includes('and lease_owner = p_owner'), `${fn} 에 owner 일치 조건 없음`);
  }
});

test('heartbeat: owner 일치만으로는 부족 — lease_expires_at 이 NOT NULL 이고 아직 미래일 때만 성공(만료 lease 부활 차단)', () => {
  const src = read(UP);
  const at = src.indexOf('create or replace function public.hospital_collection_job_heartbeat(');
  assert.ok(at > 0);
  const block = src.slice(at, src.indexOf('\n$$;', at));
  assert.ok(block.includes('and lease_owner = p_owner'), 'owner 일치 조건 없음');
  assert.ok(block.includes('and lease_expires_at is not null'), 'lease_expires_at NOT NULL 조건 없음');
  assert.ok(block.includes('and lease_expires_at > now()'), 'lease_expires_at 미래 조건 없음');
  // WHERE 절이 owner 일치 → NOT NULL → 미래 순서로 AND 로 연결돼 있어야(단일 UPDATE, 셀렉트 후 판단 아님).
  const whereAt = block.indexOf('where id = p_job_id');
  assert.ok(whereAt > 0);
  const whereBlock = block.slice(whereAt, block.indexOf(';', whereAt) + 1);
  assert.match(whereBlock, /and lease_owner = p_owner\s*\n\s*and lease_expires_at is not null\s*\n\s*and lease_expires_at > now\(\);/);
});

test('release_lease: lease 해제와 상태 전이가 같은 UPDATE 문 안에서 원자적으로 처리됨', () => {
  const src = read(UP);
  const at = src.indexOf('create or replace function public.hospital_collection_job_release_lease(');
  const block = src.slice(at, src.indexOf('\n$$;', at));
  const updateCount = (block.match(/\bupdate\s+public\.hospital_collection_jobs\b/gi) || []).length;
  assert.equal(updateCount, 1, 'release_lease 가 UPDATE 를 1개보다 많이/적게 사용');
  assert.ok(block.includes('lease_owner      = null'));
  assert.ok(block.includes('status           = coalesce(p_next_status, status)'));
});

test('reserve_daily_calls: 날짜는 함수 인자로 받지 않고 서버가 Asia/Seoul 로 계산', () => {
  const src = read(UP);
  const sigAt = src.indexOf('create or replace function public.hospital_hira_reserve_daily_calls(');
  const sigEnd = src.indexOf(')', sigAt);
  const sig = src.slice(sigAt, sigEnd);
  assert.equal(/date/i.test(sig), false, '함수 시그니처에 날짜 인자가 있음 — 서버 계산 원칙 위반');
  const block = src.slice(sigAt, src.indexOf('\n$$;', sigAt));
  assert.ok(block.includes("(now() at time zone 'Asia/Seoul')::date"));
});

test('reserve_daily_calls: 하드 상한 2000, 요청 cap 은 least() 로 클램프', () => {
  const src = read(UP);
  const at = src.indexOf('create or replace function public.hospital_hira_reserve_daily_calls(');
  const block = src.slice(at, src.indexOf('\n$$;', at));
  assert.ok(block.includes('v_hard_cap constant integer := 2000'));
  assert.ok(block.includes('v_effective_cap := least(p_requested_cap, v_hard_cap)'));
});

test('reserve_daily_calls: cap 초과 시 예약량이 늘지 않도록 UPDATE 의 WHERE 절이 증가분+기존값을 cap 과 직접 비교(단일 문, read-then-write 아님)', () => {
  const src = read(UP);
  const at = src.indexOf('create or replace function public.hospital_hira_reserve_daily_calls(');
  const block = src.slice(at, src.indexOf('\n$$;', at));
  // 별도 SELECT 로 현재값을 읽어와 애플리케이션 판단을 하지 않는지 확인 (upsert 의 on conflict do nothing 는 허용)
  const selectIntoCount = (block.match(/select\s+.*into\s+/gi) || []).length;
  assert.equal(selectIntoCount, 0, 'SELECT ... INTO 로 값을 먼저 읽는 read-then-write 패턴이 있음');
  const updateCount = (block.match(/\bupdate\s+public\.hospital_hira_daily_usage\b/gi) || []).length;
  assert.equal(updateCount, 1, 'reserve_daily_calls 가 UPDATE 를 1개보다 많이/적게 사용');
  assert.ok(block.includes('and reserved_calls + p_calls <= v_effective_cap'));
});

test('reserve_daily_calls: 잘못된 cap·음수·0·과도한 예약량 입력을 거부(raise exception)', () => {
  const src = read(UP);
  const at = src.indexOf('create or replace function public.hospital_hira_reserve_daily_calls(');
  const block = src.slice(at, src.indexOf('\n$$;', at));
  assert.ok(block.includes("if p_calls is null or p_calls <= 0 or p_calls > v_hard_cap then"));
  assert.ok(block.includes("if p_requested_cap is null or p_requested_cap <= 0 then"));
  assert.ok(block.includes("raise exception 'invalid_call_count'"));
  assert.ok(block.includes("raise exception 'invalid_requested_cap'"));
});

test('006 down: 신규 객체(테이블 3개+함수 4개)만 제거하고 facilities/LTC/기존 스키마는 건드리지 않음', () => {
  const src = read(DOWN);
  assert.ok(src.includes('drop table if exists public.hospital_collection_items  cascade'));
  assert.ok(src.includes('drop table if exists public.hospital_collection_jobs   cascade'));
  assert.ok(src.includes('drop table if exists public.hospital_hira_daily_usage  cascade'));
  for (const fn of [
    'hospital_hira_reserve_daily_calls(integer, integer)',
    'hospital_collection_job_release_lease(uuid, text, text)',
    'hospital_collection_job_heartbeat(uuid, text, integer)',
    'hospital_collection_job_acquire_lease(uuid, text, integer)',
  ]) {
    assert.ok(src.includes(`drop function if exists public.${fn}`), `${fn} drop 없음`);
  }
  // -- 주석은 제외하고 실제 SQL 문에만 대상 테이블명이 없는지 확인(주석에는 설명상 언급 가능).
  const codeOnly = src.replace(/--[^\n]*/g, '');
  assert.equal(/facilities|hospital_profiles|facility_sources|facility_evaluations|ingestion_runs/i.test(codeOnly), false,
    'down 스크립트의 실행문이 001 이 만든 기존 테이블을 건드림');
  assert.ok(src.includes("delete from public.schema_migrations where version = '006_hospital_collection'"));
});

test('007 verify: 필수 검증 항목이 모두 존재(테이블/CHECK/UNIQUE/인덱스/RLS/policy0/함수권한)', () => {
  const src = read(VERIFY);
  const mustInclude = [
    'C1 신규 테이블 생성 수', 'C2 hospital_collection_jobs CHECK 수', 'C2b hospital_collection_jobs_job_chk',
    'C3 uq_hospital_collection_jobs_active_per_job',
    'C3b 활성 상태 범위 고정', 'C4 hospital_collection_items UNIQUE 수', 'C5 hospital_collection_items CHECK 수',
    'C6 idx_hospital_collection_items_job_status_ordinal', 'C7 hospital_collection_items → facilities FK 없음',
    'C8 hospital_collection_items 금지 컬럼명 패턴', 'C9 hospital_hira_daily_usage CHECK 수',
    'C11 신규 테이블 RLS 활성', 'C12 신규 테이블 policy 수', 'C13 신규 함수 생성 수',
    'C14 신규 함수 SECURITY DEFINER 수', 'C15 신규 함수 public/anon/authenticated execute 권한 수',
    'C16 신규 함수 service_role execute 권한 수', 'C17 schema_migrations 006 기록',
  ];
  for (const m of mustInclude) assert.ok(src.includes(m), `verify 에 "${m}" 항목 없음`);
  // 이번 라운드에 추가한 검증(heartbeat 만료 차단, last_error_code slug 형식)도 존재해야 함.
  assert.ok(src.includes('C13b heartbeat 만료 lease 부활 차단 조건 존재'));
  assert.ok(src.includes('C5b last_error_code slug 정규식 CHECK'));
});

test('005 preflight: 신규 테이블/함수/제약 이름 충돌 및 필요한 역할 존재를 사전 확인', () => {
  const src = read(PREFLIGHT);
  assert.ok(src.includes('A4 신규 테이블 기존재 개수'));
  assert.ok(src.includes('A5 신규 함수 기존재 개수'));
  assert.ok(src.includes('A6 제약·인덱스 이름 충돌'));
  assert.ok(src.includes('A8 anon/authenticated/service_role 역할 존재'));
  // 오류 코드 계약 수정으로 이름이 바뀐 제약(len→fmt)이 최신 이름으로 반영돼 있는지.
  assert.ok(src.includes('hospital_collection_jobs_last_error_code_fmt_chk'));
  assert.ok(src.includes('hospital_collection_items_last_error_code_fmt_chk'));
  assert.equal(src.includes('hospital_collection_jobs_last_error_code_len_chk'), false, '옛 제약명이 남아있음');
  assert.equal(src.includes('hospital_collection_items_last_error_code_len_chk'), false, '옛 제약명이 남아있음');
});

test('schema.sql / baseline_schema.sql 은 이번 작업에서 수정하지 않음(001 선례와 동일하게 마이그레이션만 갱신)', () => {
  // 근거: 001 이 6개 신규 테이블을 만들었지만 schema.sql 에는 반영되지 않았고,
  // baseline_schema.sql 은 "001 적용 전" 시점의 고정 스냅샷으로 문서화돼 있다
  // (파일 자체가 '작성: 2026-09-02 (1A 단계)' 라고 명시). 같은 선례를 따른다.
  const schema = read('db/schema.sql');
  const baseline = read('db/baseline_schema.sql');
  assert.equal(schema.includes('hospital_collection_jobs'), false);
  assert.equal(baseline.includes('hospital_collection_jobs'), false);
  // 001 이 만든 테이블도 여전히 반영 안 된 상태(선례가 유지되고 있음을 재확인)
  assert.equal(schema.includes('hospital_profiles'), false);
});

test('LTC·기존 hospital 스키마/코드 무변경 (이번 브랜치는 db/migrations/005·006·007 + 테스트만)', () => {
  for (const f of ['api/facilities.js', 'api/facility.js', 'api/ingest.js', 'api/enrich.js', 'api/consult.js',
                    'api/hospital/facility.js', 'api/hospital/facilities.js', 'api/hospital/ingest.js', 'lib/db.js']) {
    const src = read(f);
    assert.equal(/hospital_collection_jobs|hospital_collection_items|hospital_hira_daily_usage/.test(src), false,
      `${f} 가 이번 신규 테이블을 참조함(범위 밖 — 배치 API 는 별도 작업)`);
  }
});
