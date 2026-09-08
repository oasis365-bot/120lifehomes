// =====================================================================
// 요양병원 정규화 레코드 → Supabase 저장 계층 (1B-3)
// =====================================================================
//  저장 대상: facilities · hospital_profiles · facility_sources ·
//            facility_evaluations · ingestion_runs · facility_revisions
//
//  원칙:
//   · HIRA 기관 id = "H-" + ykiho (adapter.hospitalIdFromYkiho), domain = 'HOSPITAL'
//   · 운영자 입력 컬럼(monthly_fee/entry_fee/care_levels/features/intro/is_partner,
//     capacity/current_count/eval_grade/eval_date/detail_synced_at 등)은 절대 안 건드림
//     → buildFacilityRow / buildProfileRow 가 파이프라인 소유 컬럼만 만든다.
//   · facility_sources.normalized_hash 가 "이 기관 정규화 데이터가 바뀌었나" 의 단일 기준.
//     hash 동일 → 아무것도 안 씀 (unchanged).
//   · 변경된 facilities 컬럼은 facility_revisions 에 changed_by='pipeline:...' 로 기록.
//   · evaluation_year 는 HIRA 미제공 → 항상 NULL. 표현식 UNIQUE 인덱스
//     uq_facility_evaluations_logical 는 PostgREST on_conflict 로 못 쓰므로
//     SELECT(evaluation_year IS NULL) 후 PATCH/POST. 동시 충돌(409)이면 재조회 후 PATCH.
//   · 평가연도·폐업상태 추측 금지 (adapter 단계에서 이미 null).
//   · raw 원본 + dataset_id + fetched_at 을 facility_sources 에 보존.
//
//  DB 호출은 deps.sb 로 주입 (lib/db.js 의 sb). 이 모듈은 process.env·fetch 를 직접 안 쓴다.
// =====================================================================
import {
  HOSPITAL_DOMAIN,
  HOSPITAL_SOURCE,
  HOSPITAL_TYPE_CODE,
  HOSPITAL_TYPE_LABEL,
} from './adapter.js';
import { maskYkiho } from './collect.js';

export const HOSPITAL_INGEST_JOB = 'hira_hospital_ingest';
export const SOURCE_SYSTEM = 'hira_hospital_ingest';
export const HIRA_DATASET_ID = 'B551182';
export const REVISION_ACTOR = 'pipeline:hira_hospital_ingest';

// 1B-3 Preview 전용 DB 목적지 (정확 일치만 허용).
// ※ 이 값은 실 적재 안전용 scaffolding — 1B-3B 검증 완료 후 main 병합 전에 env 변수화 또는 제거 검토.
// ※ 런타임에는 이 상수도, SUPABASE_URL 도 응답·에러·로그에 절대 노출하지 않는다 (verifyPreviewDbUrl 은 wrong_preview_db 만 반환).
export const EXPECTED_PREVIEW_DB_HOST = 'sojxqkwdkpkifpxvzexz.supabase.co';

// facilities 파이프라인 소유 컬럼 (이 목록에 없는 컬럼은 절대 write 하지 않음 = 운영자 보호)
const FACILITY_PIPELINE_FIELDS = [
  'name', 'address', 'sido', 'sigungu_nm', 'dong_nm', 'post_no', 'phone',
  'established_at', 'lat', 'lng', 'type_code', 'type_label', 'domain', 'source', 'hira_ykiho',
];
const FACILITY_SELECT = ['id', ...FACILITY_PIPELINE_FIELDS].join(',');

const HOSPITAL_PROFILE_FIELDS = [
  'hira_ykiho', 'establishment_type', 'bed_total', 'bed_detail', 'specialties',
  'specialist_counts', 'equipment', 'homepage', 'medical_services',
];

// ── util ──
const enc = (v) => encodeURIComponent(String(v));
const nn = (v) => (v === undefined ? null : v);
function briefErr(e) {
  return String((e && e.message) || e || '')
    .slice(0, 200)
    .replace(/[A-Za-z0-9+/]{40,}={0,2}/g, '***'); // base64 유사 토큰(ykiho 등) 제거
}
function isConflict(e) {
  const m = String((e && e.message) || '');
  return /Supabase 409/.test(m) || /\b23505\b/.test(m) || /duplicate key|conflict/i.test(m);
}
function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    return Object.keys(v).sort().reduce((a, k) => ((a[k] = sortDeep(v[k])), a), {});
  }
  return v;
}
const canon = (v) => JSON.stringify(sortDeep(v ?? null));
function sameScalar(a, b) {
  const x = a ?? null;
  const y = b ?? null;
  if (x === y) return true;
  if (typeof x === 'number' && typeof y === 'number') return x === y;
  return false;
}
const toStr = (v) => (v === null || v === undefined ? null : String(v));

// ── row builders (파이프라인 소유 컬럼만) ──
export function buildFacilityRow(h) {
  return {
    hira_ykiho: h.external_id,
    domain: HOSPITAL_DOMAIN,
    source: HOSPITAL_SOURCE,
    type_code: HOSPITAL_TYPE_CODE,
    type_label: HOSPITAL_TYPE_LABEL,
    name: nn(h.name),
    address: nn(h.address),
    sido: nn(h.sido),
    sigungu_nm: nn(h.sigungu_nm),
    dong_nm: nn(h.dong_nm),
    post_no: nn(h.post_no),
    phone: nn(h.phone),
    established_at: nn(h.established_at),
    lat: h.lat ?? null,
    lng: h.lng ?? null,
  };
}

export function buildProfileRow(h, facilityId) {
  return {
    facility_id: facilityId,
    hira_ykiho: h.external_id,
    establishment_type: nn(h.establishment_type),
    bed_total: h.bed_total ?? null,
    bed_detail: h.bed_detail ?? null,
    specialties: Array.isArray(h.specialties) ? h.specialties : [],
    specialist_counts: h.specialist_counts ?? null,
    equipment: h.equipment ?? null,
    homepage: nn(h.homepage),
    medical_services: h.medical_services && typeof h.medical_services === 'object' ? h.medical_services : {},
  };
}

// ── 평가 upsert (표현식 인덱스 → SELECT 후 PATCH/POST) ──
async function upsertEvaluation(e, facilityId, ctx) {
  const { sb, now, stats } = ctx;
  const q =
    `facility_evaluations?facility_id=eq.${enc(facilityId)}` +
    `&evaluation_authority=eq.${enc(e.evaluation_authority)}` +
    `&evaluation_name=eq.${enc(e.evaluation_name)}` +
    `&evaluation_year=is.null&select=id,grade,grade_scale&limit=1`;

  const found = (await sb(q)).data?.[0] || null;

  if (found) {
    if (found.grade !== e.grade || found.grade_scale !== e.grade_scale) {
      await sb(`facility_evaluations?id=eq.${enc(found.id)}`, {
        method: 'PATCH',
        body: { grade: e.grade, grade_scale: e.grade_scale, source_reference: e.source_reference ?? null, collected_at: now() },
        prefer: 'return=minimal',
      });
      stats.evalUpdated += 1;
    }
    return;
  }

  const row = {
    facility_id: facilityId,
    evaluation_authority: e.evaluation_authority,
    evaluation_name: e.evaluation_name,
    evaluation_year: null, // HIRA 미제공 — 추측 금지
    grade: e.grade,
    grade_scale: e.grade_scale,
    source_url: e.source_url ?? null,
    source_reference: e.source_reference ?? null,
    source_date: null,
    collected_at: now(),
  };
  try {
    await sb('facility_evaluations', { method: 'POST', body: [row], prefer: 'return=minimal' });
    stats.evalNew += 1;
  } catch (err) {
    if (!isConflict(err)) throw err;
    // 동시 충돌 → 재조회 후 PATCH (중복 INSERT 금지)
    const re = (await sb(q)).data?.[0] || null;
    if (!re) throw err; // 재조회도 없으면 상위에서 실패 기록
    await sb(`facility_evaluations?id=eq.${enc(re.id)}`, {
      method: 'PATCH',
      body: { grade: e.grade, grade_scale: e.grade_scale, collected_at: now() },
      prefer: 'return=minimal',
    });
    stats.evalUpdated += 1;
  }
}

// ── 기관 1건 처리 ──
async function processOne(item, ctx) {
  const { sb, now, stats, failures } = ctx;
  const h = item && item.hospital;
  const e = item && item.evaluation;
  const raw = item && item.raw;

  const ykiho = h && h.external_id;
  const id = h && h.id;
  if (!ykiho || !id) {
    stats.failed += 1;
    failures.push({ ykiho: maskYkiho(ykiho), step: 'input', reason: 'missing_id_or_ykiho' });
    return;
  }
  if (ctx.seen.has(ykiho)) {
    stats.unchanged += 1; // 배치 내 ykiho 중복 → 스킵
    return;
  }
  ctx.seen.add(ykiho);

  let wrote = false;
  try {
    // 1) 변경 감지 앵커
    const srcRow = (
      await sb(`facility_sources?source_system=eq.${enc(SOURCE_SYSTEM)}&external_id=eq.${enc(ykiho)}&select=normalized_hash&limit=1`)
    ).data?.[0];
    if (srcRow && srcRow.normalized_hash && srcRow.normalized_hash === h.normalized_hash) {
      stats.unchanged += 1;
      return;
    }

    // 2) facilities
    const facRow = buildFacilityRow(h);
    let existing = (await sb(`facilities?id=eq.${enc(id)}&select=${FACILITY_SELECT}&limit=1`)).data?.[0] || null;
    let isNew = false;

    if (!existing) {
      try {
        await sb('facilities', { method: 'POST', body: [{ id, ...facRow, synced_at: now() }], prefer: 'return=minimal' });
        wrote = true;
        isNew = true;
      } catch (err) {
        if (!isConflict(err)) throw err;
        existing = (await sb(`facilities?id=eq.${enc(id)}&select=${FACILITY_SELECT}&limit=1`)).data?.[0] || null;
        if (!existing) throw err;
      }
    }

    const changedFacFields = [];
    if (existing) {
      const diff = {};
      for (const k of FACILITY_PIPELINE_FIELDS) {
        if (!sameScalar(existing[k], facRow[k])) diff[k] = facRow[k];
      }
      if (Object.keys(diff).length) {
        await sb(`facilities?id=eq.${enc(id)}`, {
          method: 'PATCH',
          body: { ...diff, updated_at: now() },
          prefer: 'return=minimal',
        });
        wrote = true;
        for (const [field, nv] of Object.entries(diff)) {
          changedFacFields.push(field);
          await sb('facility_revisions', {
            method: 'POST',
            body: [{
              facility_id: id, field,
              old_value: toStr(existing[field]), new_value: toStr(nv),
              changed_by: REVISION_ACTOR, change_reason: 'HIRA 재수집 반영',
            }],
            prefer: 'return=minimal',
          });
          stats.revisions += 1;
        }
      }
    }

    // 3) hospital_profiles
    const profRow = buildProfileRow(h, id);
    const prof = (await sb(`hospital_profiles?facility_id=eq.${enc(id)}&select=facility_id,${HOSPITAL_PROFILE_FIELDS.join(',')}&limit=1`)).data?.[0] || null;
    if (!prof) {
      try {
        await sb('hospital_profiles', { method: 'POST', body: [{ ...profRow, created_at: now(), updated_at: now() }], prefer: 'return=minimal' });
        wrote = true;
      } catch (err) {
        if (!isConflict(err)) throw err;
        const pdiff = profileDiff({}, profRow);
        if (Object.keys(pdiff).length) {
          await sb(`hospital_profiles?facility_id=eq.${enc(id)}`, { method: 'PATCH', body: { ...pdiff, updated_at: now() }, prefer: 'return=minimal' });
          wrote = true;
        }
      }
    } else {
      const pdiff = profileDiff(prof, profRow);
      if (Object.keys(pdiff).length) {
        await sb(`hospital_profiles?facility_id=eq.${enc(id)}`, { method: 'PATCH', body: { ...pdiff, updated_at: now() }, prefer: 'return=minimal' });
        wrote = true;
      }
    }

    // 4) facility_sources — unique(source_system, external_id) → merge-duplicates 가능
    await sb('facility_sources?on_conflict=source_system,external_id', {
      method: 'POST',
      body: [{
        facility_id: id,
        source_system: SOURCE_SYSTEM,
        dataset_id: HIRA_DATASET_ID,
        external_id: ykiho,
        raw: raw ?? null,
        normalized_hash: h.normalized_hash ?? null,
        source_date: null,
        fetched_at: now(),
      }],
      prefer: 'resolution=merge-duplicates,return=minimal',
    });
    wrote = true;

    // 5) facility_evaluations
    if (e && e.grade !== null && e.grade !== undefined && e.grade !== '') {
      await upsertEvaluation(e, id, ctx);
    } else {
      stats.evalMissing += 1;
    }

    if (isNew) stats.new += 1;
    else stats.updated += 1; // hash 가 달랐으므로 (source·revision·profile 중 하나 이상 갱신)
  } catch (err) {
    if (wrote) {
      stats.partial += 1;
      failures.push({ ykiho: maskYkiho(ykiho), step: 'persist', reason: briefErr(err), partial: true });
    } else {
      stats.failed += 1;
      failures.push({ ykiho: maskYkiho(ykiho), step: 'persist', reason: briefErr(err) });
    }
  }
}

function profileDiff(existing, next) {
  const d = {};
  for (const k of Object.keys(next)) {
    if (k === 'facility_id') continue;
    if (canon(existing[k]) !== canon(next[k])) d[k] = next[k];
  }
  return d;
}

/**
 * 정규화 결과 배열을 Supabase 에 upsert.
 * @param {Array<{hospital:object, evaluation:object|null, raw:object}>} items  collect._normalizedAll
 * @param {object} deps  { sb, now }
 * @returns {Promise<{ runId:(number|null), stats:object, failures:object[] }>}
 */
export async function persistCollected(items, deps = {}) {
  const sb = deps.sb;
  if (typeof sb !== 'function') throw new Error('persistCollected: deps.sb 필요');
  const now = deps.now || (() => new Date().toISOString());
  const list = Array.isArray(items) ? items : [];

  const stats = {
    total: list.length,
    new: 0, updated: 0, unchanged: 0, partial: 0, failed: 0,
    evalNew: 0, evalUpdated: 0, evalMissing: 0, revisions: 0,
  };
  const failures = [];

  // ingestion_runs: running 행
  let runId = null;
  try {
    const r = await sb('ingestion_runs', {
      method: 'POST',
      body: [{ job: HOSPITAL_INGEST_JOB, started_at: now(), status: 'running' }],
      prefer: 'return=representation',
    });
    runId = (Array.isArray(r.data) ? r.data[0] : r.data)?.id ?? null;
  } catch {
    runId = null; // 로그 실패는 적재를 막지 않는다
  }

  // 빈 입력 → 시설 write 없이 failed 로 마감. status=ok 금지.
  if (list.length === 0) {
    failures.push({ step: 'input', reason: 'empty_input' });
    if (runId != null) {
      try {
        await sb(`ingestion_runs?id=eq.${enc(runId)}`, {
          method: 'PATCH',
          body: {
            finished_at: now(), status: 'failed',
            count_new: 0, count_updated: 0, count_closed: 0, count_error: 1,
            detail: { reason: 'empty_input', inputCount: 0 },
          },
          prefer: 'return=minimal',
        });
      } catch { /* ignore */ }
    }
    return { runId, status: 'failed', stats, failures };
  }

  const ctx = { sb, now, stats, failures, seen: new Set() };
  for (const item of list) {
    // eslint-disable-next-line no-await-in-loop
    await processOne(item, ctx);
  }

  const anySuccess = stats.new + stats.updated + stats.unchanged > 0;
  // 처리 건수 합계가 입력 수와 안 맞으면(누락/이상) 성공으로 보지 않는다.
  const accounted = stats.new + stats.updated + stats.unchanged + stats.partial + stats.failed;
  const status =
    !anySuccess && stats.failed > 0 ? 'failed'
      : accounted !== list.length ? 'failed'
        : (stats.failed || stats.partial ? 'partial' : 'ok');

  if (runId != null) {
    try {
      await sb(`ingestion_runs?id=eq.${enc(runId)}`, {
        method: 'PATCH',
        body: {
          finished_at: now(),
          status,
          count_new: stats.new,
          count_updated: stats.updated,
          count_closed: 0, // 폐업 감지는 이 단계 범위 아님
          count_error: stats.failed + stats.partial,
          detail: {
            unchanged: stats.unchanged,
            partial: stats.partial,
            evalNew: stats.evalNew,
            evalUpdated: stats.evalUpdated,
            evalMissing: stats.evalMissing,
            revisions: stats.revisions,
            failures, // ykiho 마스킹됨
          },
        },
        prefer: 'return=minimal',
      });
    } catch {
      /* ignore */
    }
  }

  return { runId, status, stats, failures };
}

/**
 * SUPABASE_URL 이 "정확히" 지정된 Preview DB 를 가리키는지 검증.
 *   · new URL() 로 파싱 (파싱 불가 → 거부)
 *   · protocol 은 반드시 'https:'
 *   · hostname 은 EXPECTED_PREVIEW_DB_HOST 와 정확 일치 (===). 부분문자열/endsWith/includes 안 씀.
 *   · username / password / port / path(/제외) / query / hash 있으면 거부
 * 실패 시 { ok:false, reason:'wrong_preview_db' } — URL·ref 를 담지 않는다.
 * @param {string} rawUrl
 * @param {string} [expectedHost]
 * @returns {{ ok:boolean, reason:(string|null) }}
 */
export function verifyPreviewDbUrl(rawUrl, expectedHost = EXPECTED_PREVIEW_DB_HOST) {
  const FAIL = { ok: false, reason: 'wrong_preview_db' };
  const s = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!s) return FAIL;

  let u;
  try {
    u = new URL(s);
  } catch {
    return FAIL;
  }
  if (u.protocol !== 'https:') return FAIL;
  if (u.hostname !== expectedHost) return FAIL; // 정확 일치만
  if (u.username || u.password) return FAIL;
  if (u.port) return FAIL;
  if (u.pathname && u.pathname !== '/') return FAIL;
  if (u.search) return FAIL;
  if (u.hash) return FAIL;
  return { ok: true, reason: null };
}

/**
 * 이 DB 가 "Preview 전용 빈 DB" 인지 확인. 운영 Supabase / 다른 목적지 로 보이면 { ok:false }.
 * reason 은 generic 코드만 (URL·행수·프로젝트 ref·키 미노출).
 * @param {object} deps  { sb, env }
 */
export async function assertPreviewDb(deps = {}) {
  const sb = deps.sb;
  const env = deps.env || {};
  if (typeof sb !== 'function') return { ok: false, reason: 'no_sb' };
  if (env.VERCEL_ENV === 'production') return { ok: false, reason: 'production_env' };

  // (0) DB 목적지 검증 — 어떤 쿼리보다도 먼저. 틀린 DB 면 접속 자체를 안 한다.
  const dest = verifyPreviewDbUrl(env.SUPABASE_URL);
  if (!dest.ok) return { ok: false, reason: 'wrong_preview_db' };

  // (1) 운영 DB 판별 — 요양원(LTC) 실데이터가 있으면 운영 DB 로 간주하고 중단
  let ltcCount = null;
  try {
    const r = await sb('facilities?domain=eq.LTC&select=id&limit=1', { prefer: 'count=exact' });
    ltcCount = r.count != null ? r.count : (Array.isArray(r.data) ? r.data.length : null);
  } catch {
    return { ok: false, reason: 'facilities_query_failed' };
  }
  if (ltcCount == null) return { ok: false, reason: 'ltc_count_unknown' };
  if (ltcCount > 0) return { ok: false, reason: 'db_has_ltc_rows' };

  // (2) 001 스키마 존재 확인
  try {
    await sb('facility_sources?select=id&limit=1');
    await sb('hospital_profiles?select=facility_id&limit=1');
    await sb('ingestion_runs?select=id&limit=1');
  } catch {
    return { ok: false, reason: 'schema_incomplete' };
  }

  // (3) hospital_module 플래그
  let flag;
  try {
    flag = (await sb('feature_flags?key=eq.hospital_module&select=enabled&limit=1')).data?.[0];
  } catch {
    return { ok: false, reason: 'flags_query_failed' };
  }
  if (!flag) return { ok: false, reason: 'flag_missing' };
  if (flag.enabled === true) return { ok: false, reason: 'hospital_module_on' };

  return { ok: true, reason: null };
}
