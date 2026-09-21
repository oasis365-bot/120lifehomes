// 전국 요양병원 snapshot discovery — 호출당 HIRA 목록 1페이지만 처리한다.
// 기관명·주소·ykiho 원문은 job/item 상태 테이블에 저장하지 않는다.
import { randomUUID } from 'node:crypto';
import { HiraError } from './client.js';
import { HOSPITAL_CL_CD, hospitalIdFromYkiho } from './adapter.js';
import { isNormalResult } from './parse.js';

export const COLLECTION_JOB = 'hira_hospital_nationwide';
// discovery 원본은 job/item 테이블이 아니라 기존 감사용 facility_sources 에만 보관한다.
// enrichment 는 이 raw basis 를 읽어 기관명·주소를 추측하지 않고 정규화한다.
export const DISCOVERY_SOURCE_SYSTEM = 'hira_hospital_discovery';
export const DISCOVERY_DATASET_ID = 'B551182';
export const DISCOVERY_PAGE_SIZE = 100;
// PostgREST 일괄 insert는 한 페이지의 100개를 한 번에 전송하지 않는다. 이전 실행에서
// 동일한 행은 SQL로 정상 삽입됐으나 REST 일괄 요청만 반복 실패해, 작은 멱등 단위로 나눈다.
export const DISCOVERY_ITEM_WRITE_CHUNK_SIZE = 25;
export const DAILY_CALL_CAP_DEFAULT = 1000;
export const DAILY_CALL_CAP_HARD_MAX = 2000;
export const BATCH_ERROR_CODES = Object.freeze({
  quotaExhausted: 'quota_exhausted',
  hiraRateLimited: 'hira_rate_limited',
  hiraTimeout: 'hira_timeout',
  hiraNetwork: 'hira_network',
  hiraDns: 'hira_dns',
  hiraTls: 'hira_tls',
  hiraHttp5xx: 'hira_http_5xx',
  hiraResultCode12: 'hira_result_code_12',
  hiraGatewayError: 'hira_gateway_error',
  hiraResponseInvalid: 'hira_response_invalid',
  hiraDeadlineExceeded: 'hira_deadline_exceeded',
  quotaReservationFailed: 'quota_reservation_failed',
  hiraUnknownTransport: 'hira_unknown_transport',
  hiraConfigError: 'hira_config_error',
  hiraHttpUnknown: 'hira_http_unknown',
  discoveryStorageError: 'discovery_storage_error',
  discoveryItemsReadError: 'discovery_items_read_error',
  discoverySourcesWriteError: 'discovery_sources_write_error',
  discoveryItemsWriteError: 'discovery_items_write_error',
  discoveryCheckpointWriteError: 'discovery_checkpoint_write_error',
  discoveryInternalError: 'discovery_internal_error',
  discoveryFailed: 'discovery_failed',
});
const RETRY_LATER_FAILURE_KINDS = new Set([
  'timeout', 'network', 'dns', 'tls', 'http_5xx', 'result_code_12',
]);
const ACTIVE_STATUSES = 'pending,running,paused_for_today';
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

const enc = (v) => encodeURIComponent(String(v));
const scalarBool = (v) => v === true || (Array.isArray(v) && v[0] === true);

class DiscoveryStorageError extends Error {
  constructor(stage) {
    super('discovery_storage_error');
    this.name = 'DiscoveryStorageError';
    this.stage = stage;
  }
}

async function storageStep(stage, task) {
  try { return await task(); } catch { throw new DiscoveryStorageError(stage); }
}

// PostgREST write는 연결이 응답 직전에 끊겨도 서버 반영 여부를 알 수 없다.
// discovery의 두 upsert는 conflict-safe이므로 한 번만 재시도해도 중복 없이
// 일시적인 네트워크/게이트웨이 실패를 흡수할 수 있다.
async function retryableStorageWrite(stage, task) {
  try {
    return await task();
  } catch {
    try {
      return await task();
    } catch {
      throw new DiscoveryStorageError(stage);
    }
  }
}

function activeJobPath() {
  return `hospital_collection_jobs?job=eq.${COLLECTION_JOB}` +
    `&status=in.(${ACTIVE_STATUSES})&select=*&order=created_at.asc&limit=1`;
}

function safeCap(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return DAILY_CALL_CAP_DEFAULT;
  return Math.min(n, DAILY_CALL_CAP_HARD_MAX);
}

function isConflict(e) {
  return /Supabase 409|\b23505\b|duplicate key|conflict/i.test(String(e?.message || ''));
}

function kstDayBucket(epochMs) {
  return Math.floor((epochMs + KST_OFFSET_MS) / 86_400_000);
}

function shouldKeepDailyPause(job, nowMs) {
  if (job?.status !== 'paused_for_today') return false;
  const updatedMs = Date.parse(job.updated_at);
  return !Number.isFinite(updatedMs) || updatedMs > nowMs ||
    kstDayBucket(updatedMs) >= kstDayBucket(nowMs);
}

// HIRA ykiho는 실측상 URL-safe/base64 계열 opaque 값이다. 상태 테이블에는 기존
// 공개 facility_id만 저장하되, URL·공백·제어문자·비정상 장문이 섞인 값은 거부한다.
function validHospitalFacilityId(id) {
  return typeof id === 'string' && id.length >= 3 && id.length <= 200 &&
    /^H-[A-Za-z0-9+/_=-]+$/.test(id);
}

async function findOrCreateJob(sb, uuid) {
  let job = (await sb(activeJobPath())).data?.[0] || null;
  if (job) return job;
  const id = uuid();
  try {
    const r = await sb('hospital_collection_jobs', {
      method: 'POST',
      body: [{ id, job: COLLECTION_JOB, status: 'pending', phase: 'discovery', discovery_page: 0 }],
      prefer: 'return=representation',
    });
    return (Array.isArray(r.data) ? r.data[0] : r.data) || null;
  } catch (e) {
    if (!isConflict(e)) throw e;
    job = (await sb(activeJobPath())).data?.[0] || null;
    if (job) return job;
    throw e;
  }
}

async function rpcBool(sb, name, body) {
  const r = await sb(`rpc/${name}`, { method: 'POST', body, prefer: 'return=representation' });
  return scalarBool(r.data);
}

async function release(sb, jobId, owner, nextStatus) {
  return rpcBool(sb, 'hospital_collection_job_release_lease', {
    p_job_id: jobId, p_owner: owner, p_next_status: nextStatus,
  });
}

async function setJobError(sb, jobId, code) {
  await sb(`hospital_collection_jobs?id=eq.${enc(jobId)}`, {
    method: 'PATCH', body: { last_error_code: code }, prefer: 'return=minimal',
  });
}

function hiraErrorInfo(error) {
  if (!error || typeof error !== 'object') return null;
  // 번들 경계 등으로 instanceof가 실패해도, HiraError가 이미 허용한 범주값만 사용한다.
  if (!(error instanceof HiraError) && error.name !== 'HiraError') return null;
  return {
    reason: typeof error.reason === 'string' ? error.reason : 'unknown',
    failureKind: typeof error.failureKind === 'string' ? error.failureKind : 'unknown',
  };
}

function retryLater(error) {
  const info = hiraErrorInfo(error);
  return Boolean(info && RETRY_LATER_FAILURE_KINDS.has(info.failureKind));
}

function discoveryErrorCode(error, { quota, upstreamLimit, retryable }) {
  if (quota) return BATCH_ERROR_CODES.quotaExhausted;
  if (upstreamLimit) return BATCH_ERROR_CODES.hiraRateLimited;
  if (retryable) {
    const map = {
      timeout: BATCH_ERROR_CODES.hiraTimeout,
      network: BATCH_ERROR_CODES.hiraNetwork,
      dns: BATCH_ERROR_CODES.hiraDns,
      tls: BATCH_ERROR_CODES.hiraTls,
      http_5xx: BATCH_ERROR_CODES.hiraHttp5xx,
      result_code_12: BATCH_ERROR_CODES.hiraResultCode12,
    };
    return map[hiraErrorInfo(error)?.failureKind] || BATCH_ERROR_CODES.discoveryFailed;
  }
  // 원문·URL·키 없이도 운영자가 다음 조치를 판단할 수 있도록, 재시도 대상이 아닌
  // HIRA 오류는 안전한 범주 코드로만 구분한다.
  const hira = hiraErrorInfo(error);
  if (hira) {
    if (hira.reason === 'gateway') return BATCH_ERROR_CODES.hiraGatewayError;
    if (hira.reason === 'result') return BATCH_ERROR_CODES.hiraResponseInvalid;
    if (hira.reason === 'deadline') return BATCH_ERROR_CODES.hiraDeadlineExceeded;
    if (hira.reason === 'quota_guard') return BATCH_ERROR_CODES.quotaReservationFailed;
    if (hira.reason === 'config') return BATCH_ERROR_CODES.hiraConfigError;
    if (hira.reason === 'http') return BATCH_ERROR_CODES.hiraHttpUnknown;
    if (hira.reason === 'aborted_all' || hira.reason === 'network' || hira.reason === 'timeout') {
      return BATCH_ERROR_CODES.hiraUnknownTransport;
    }
  }
  // Supabase 응답 원문·경로는 저장하지 않고, 저장소 오류 여부만 구분한다.
  if (typeof error?.message === 'string' && error.message.startsWith('Supabase ')) {
    return BATCH_ERROR_CODES.discoveryStorageError;
  }
  if (error instanceof DiscoveryStorageError) {
    const map = {
      items_read: BATCH_ERROR_CODES.discoveryItemsReadError,
      sources_write: BATCH_ERROR_CODES.discoverySourcesWriteError,
      items_write: BATCH_ERROR_CODES.discoveryItemsWriteError,
      checkpoint_write: BATCH_ERROR_CODES.discoveryCheckpointWriteError,
    };
    return map[error.stage] || BATCH_ERROR_CODES.discoveryStorageError;
  }
  if (error instanceof Error) return BATCH_ERROR_CODES.discoveryInternalError;
  return BATCH_ERROR_CODES.discoveryFailed;
}

/**
 * 한 번에 discovery 한 페이지만 처리한다. 모든 의존성은 테스트에서 주입 가능하다.
 * @returns 안전한 집계값만. facility_id/ykiho/기관정보는 반환하지 않는다.
 */
export async function runDiscoveryPage(deps = {}) {
  const { sb, createClient, key } = deps;
  if (typeof sb !== 'function' || typeof createClient !== 'function') {
    throw new Error('batch_config_invalid');
  }
  const uuid = typeof deps.uuid === 'function' ? deps.uuid : randomUUID;
  const owner = uuid();
  const cap = safeCap(deps.dailyCallCap);
  const job = await findOrCreateJob(sb, uuid);
  if (!job?.id) throw new Error('job_unavailable');
  if (job.phase !== 'discovery') {
    return { ok: true, status: 'phase_complete', didWork: false, phase: job.phase || 'unknown' };
  }
  const nowMs = typeof deps.now === 'function' ? deps.now() : Date.now();
  if (shouldKeepDailyPause(job, nowMs)) {
    return { ok: true, status: 'paused_for_today', didWork: false, phase: 'discovery' };
  }

  const acquired = await rpcBool(sb, 'hospital_collection_job_acquire_lease', {
    p_job_id: job.id, p_owner: owner, p_lease_seconds: 90,
  });
  if (!acquired) return { ok: true, status: 'busy', didWork: false, phase: 'discovery' };

  let nextStatus = 'pending';
  try {
    const existing = (await storageStep('items_read', () => sb(
      `hospital_collection_items?job_id=eq.${enc(job.id)}` +
      '&select=facility_id,ordinal&order=ordinal.asc&limit=2000'
    ))).data || [];
    const seen = new Set(existing.map((r) => r.facility_id));
    let ordinal = existing.reduce((m, r) => Math.max(m, Number(r.ordinal) || 0), -1) + 1;
    const pageNo = Number(job.discovery_page) + 1;

    const reserveCall = async () => rpcBool(sb, 'hospital_hira_reserve_daily_calls', {
      p_calls: 1, p_requested_cap: cap,
    });
    const client = createClient({ key, beforeAttempt: reserveCall });
    const page = await client.listHospitals({
      clCd: HOSPITAL_CL_CD, pageNo, numOfRows: DISCOVERY_PAGE_SIZE,
    });
    if (page?.gatewayError === true && String(page.resultCode ?? '').trim() === '22') {
      throw new HiraError('HIRA 일일 호출 한도 응답', {
        reason: 'quota', failureKind: 'upstream_quota', attempts: page?.attempts || 1,
      });
    }
    if (!isNormalResult(page) || page.pageNo !== pageNo || !Number.isInteger(page.totalCount) || page.totalCount < 0) {
      throw new HiraError('HIRA 목록 응답 계약 불일치', {
        reason: 'result', failureKind: 'unknown', attempts: page?.attempts || 0,
      });
    }

    const sourceItems = Array.isArray(page.items) ? page.items : [];
    if (sourceItems.length > DISCOVERY_PAGE_SIZE) {
      throw new HiraError('HIRA 목록 페이지 크기 초과', { reason: 'result', failureKind: 'unknown' });
    }
    if (page.totalCount > 0 && sourceItems.length === 0) {
      throw new HiraError('HIRA 목록 빈 페이지', { reason: 'result', failureKind: 'unknown' });
    }
    const rows = [];
    const sourceRows = [];
    for (const raw of sourceItems) {
      const ykiho = typeof raw?.ykiho === 'string' ? raw.ykiho.trim() : '';
      if (!ykiho) throw new HiraError('HIRA 목록 기관 식별자 누락', { reason: 'result', failureKind: 'unknown' });
      const facilityId = hospitalIdFromYkiho(ykiho);
      if (!validHospitalFacilityId(facilityId)) {
        throw new HiraError('HIRA 목록 기관 식별자 형식 오류', { reason: 'result', failureKind: 'unknown' });
      }
      sourceRows.push({
        source_system: DISCOVERY_SOURCE_SYSTEM,
        dataset_id: DISCOVERY_DATASET_ID,
        external_id: ykiho,
        raw: { basis: raw },
        source_date: null,
        fetched_at: new Date(nowMs).toISOString(),
        normalized_hash: null,
      });
      if (!facilityId || seen.has(facilityId)) continue;
      seen.add(facilityId);
      rows.push({ job_id: job.id, ordinal, facility_id: facilityId, status: 'pending' });
      ordinal += 1;
    }
    // item 저장보다 먼저 basis 원본을 보관한다. 이 write 가 실패하면 cursor 를 전진하지
    // 않아 다음 batch 에서 안전하게 같은 목록 페이지를 다시 처리한다.
    if (sourceRows.length) {
      await retryableStorageWrite('sources_write', () => sb('facility_sources?on_conflict=source_system,external_id', {
        method: 'POST', body: sourceRows, prefer: 'resolution=merge-duplicates,return=minimal',
      }));
    }
    if (rows.length) {
      for (let start = 0; start < rows.length; start += DISCOVERY_ITEM_WRITE_CHUNK_SIZE) {
        const chunk = rows.slice(start, start + DISCOVERY_ITEM_WRITE_CHUNK_SIZE);
        // table REST bulk write 대신 service_role 전용 RPC 안에서 insert 한다.
        // lease/quota RPC와 같은 경로라 Preview의 직접 table-write 장애와 분리된다.
        const inserted = await retryableStorageWrite('items_write', () => rpcBool(
          sb,
          'hospital_collection_insert_discovery_items',
          { p_job_id: job.id, p_rows: chunk },
        ));
        if (!inserted) throw new DiscoveryStorageError('items_write');
      }
    }

    const complete = page.totalCount === 0 || pageNo * DISCOVERY_PAGE_SIZE >= page.totalCount;
    // 페이지 순서가 장기 실행 중 흔들리면 duplicate/누락으로 실제 snapshot 크기가
    // totalCount와 어긋날 수 있다. 이 경우 조용히 완료 처리하지 않고 재시작 판단을 맡긴다.
    if (complete && seen.size !== page.totalCount) {
      // TEMP DIAGNOSTIC (fix/discovery-count-mismatch-diag) — 집계 숫자만 기록, 기관 식별정보 없음.
      // 원인 확인 후 제거할 것.
      console.log('[diag] snapshot_mismatch', JSON.stringify({
        pageNo,
        totalCount: page.totalCount,
        seenSize: seen.size,
        existingBefore: existing.length,
        newRowsThisPage: rows.length,
        sourceItemsThisPage: sourceItems.length,
      }));
      throw new HiraError('HIRA snapshot 수량 불일치', { reason: 'result', failureKind: 'unknown' });
    }
    const patch = {
      discovery_page: pageNo,
      last_error_code: null,
      ...(complete ? {
        phase: 'enrichment',
        snapshot_completed_at: new Date(typeof deps.now === 'function' ? deps.now() : Date.now()).toISOString(),
        snapshot_total_count: seen.size,
      } : {}),
    };
    await storageStep('checkpoint_write', () => sb(`hospital_collection_jobs?id=eq.${enc(job.id)}`, {
      method: 'PATCH', body: patch, prefer: 'return=minimal',
    }));
    const released = await release(sb, job.id, owner, 'pending');
    if (!released) throw new Error('lease_release_failed');
    return {
      ok: true,
      status: complete ? 'snapshot_complete' : 'page_complete',
      didWork: true,
      phase: complete ? 'enrichment' : 'discovery',
      page: pageNo,
      added: rows.length,
      snapshotCount: complete ? seen.size : null,
      totalEstimated: page.totalCount,
    };
  } catch (e) {
    const quota = e instanceof HiraError && e.failureKind === 'quota_exhausted';
    const upstreamLimit = e instanceof HiraError && ['http_429', 'upstream_quota'].includes(e.failureKind);
    const retryable = retryLater(e);
    const pause = quota || upstreamLimit;
    nextStatus = pause ? 'paused_for_today' : 'pending';
    try {
      await setJobError(
        sb,
        job.id,
        discoveryErrorCode(e, { quota, upstreamLimit, retryable }),
      );
    } catch { /* noop */ }
    try { await release(sb, job.id, owner, nextStatus); } catch { /* lease expiry가 최종 회수 */ }
    if (pause) return { ok: true, status: 'paused_for_today', didWork: false, phase: 'discovery' };
    // 외부 HIRA의 일시 장애는 cursor·items를 건드리지 않고 다음 호출로 재개한다.
    // 계약 위반·식별자 이상은 그대로 throw하여 조용히 건너뛰지 않는다.
    if (retryable) return { ok: true, status: 'retry_later', didWork: false, phase: 'discovery' };
    throw e;
  }
}
