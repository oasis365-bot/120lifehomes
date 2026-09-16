// 전국 요양병원 snapshot enrichment — 호출당 기관 1곳만 상세·평가 수집한다.
// job/item 상태에는 기관명·주소·ykiho 원문을 저장·반환하지 않는다. ykiho는 기존
// 결정론적 facility_id에서 호출 중 메모리에서만 복원하고, basis 원본은 facility_sources
// 감사 레코드에서만 읽는다.
import { randomUUID } from 'node:crypto';
import { HiraError } from './client.js';
import { collectHospitals } from './collect.js';
import { persistCollected } from './persist.js';
import {
  COLLECTION_JOB, DAILY_CALL_CAP_DEFAULT, DAILY_CALL_CAP_HARD_MAX, DISCOVERY_SOURCE_SYSTEM,
} from './batch_discovery.js';

export const ENRICHMENT_MAX_ATTEMPTS = 3;
export const ENRICHMENT_LEASE_SECONDS = 90;
export const ENRICHMENT_ERROR_CODES = Object.freeze({
  sourceMissing: 'source_missing',
  partial: 'enrichment_partial',
  failed: 'enrichment_failed',
  deadline: 'deadline',
  quota: 'quota_exhausted',
  rateLimited: 'hira_rate_limited',
});

const ACTIVE_STATUSES = 'pending,running,paused_for_today';
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const RETRY_BASE_MS = 5 * 60 * 1000;
const RETRY_MAX_MS = 60 * 60 * 1000;
const enc = (v) => encodeURIComponent(String(v));
const scalarBool = (v) => v === true || (Array.isArray(v) && v[0] === true);

function activeJobPath() {
  return `hospital_collection_jobs?job=eq.${COLLECTION_JOB}` +
    `&status=in.(${ACTIVE_STATUSES})&select=*&order=created_at.asc&limit=1`;
}

function safeCap(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return DAILY_CALL_CAP_DEFAULT;
  return Math.min(n, DAILY_CALL_CAP_HARD_MAX);
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

function ykihoFromFacilityId(id) {
  const value = typeof id === 'string' ? id : '';
  if (!/^H-[A-Za-z0-9+/_=-]{1,198}$/.test(value)) return null;
  return value.slice(2);
}

function safeFailureCode(error) {
  const kind = error instanceof HiraError ? error.failureKind : null;
  if (kind === 'deadline') return ENRICHMENT_ERROR_CODES.deadline;
  if (kind === 'quota_exhausted') return ENRICHMENT_ERROR_CODES.quota;
  if (kind === 'http_429' || kind === 'upstream_quota') return ENRICHMENT_ERROR_CODES.rateLimited;
  return ENRICHMENT_ERROR_CODES.failed;
}

function pausesToday(error) {
  const kind = error instanceof HiraError ? error.failureKind : null;
  return kind === 'quota_exhausted' || kind === 'http_429' || kind === 'upstream_quota';
}

function retryAt(nowMs, attempt, paused) {
  const delay = paused ? 24 * 60 * 60 * 1000 : Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1));
  return new Date(nowMs + delay).toISOString();
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

async function nextEligibleItem(sb, jobId, nowMs) {
  const path = `hospital_collection_items?job_id=eq.${enc(jobId)}` +
    '&status=in.(pending,processing,retry_wait)&select=id,facility_id,attempt_count,status,next_retry_at,started_at' +
    '&order=ordinal.asc&limit=100';
  const rows = (await sb(path)).data || [];
  return rows.find((item) => {
    if (item.status === 'pending') return true;
    if (item.status === 'retry_wait') {
      return Number.isFinite(Date.parse(item.next_retry_at)) && Date.parse(item.next_retry_at) <= nowMs;
    }
    // Vercel 강제 종료 후 남은 processing item은 이전 lease(90초) 만료 뒤에만 회수한다.
    const startedMs = Date.parse(item.started_at);
    return item.status === 'processing' && Number.isFinite(startedMs) &&
      startedMs + ENRICHMENT_LEASE_SECONDS * 1000 <= nowMs;
  }) || null;
}

async function markItem(sb, itemId, patch) {
  await sb(`hospital_collection_items?id=eq.${enc(itemId)}`, {
    method: 'PATCH', body: patch, prefer: 'return=minimal',
  });
}

async function patchJobCounters(sb, job, stats, outcome, nowIso) {
  const next = {
    count_processed: Number(job.count_processed || 0) + (outcome === 'completed' || outcome === 'dead_letter' ? 1 : 0),
    count_new: Number(job.count_new || 0) + Number(stats?.new || 0),
    count_updated: Number(job.count_updated || 0) + Number(stats?.updated || 0),
    count_unchanged: Number(job.count_unchanged || 0) + Number(stats?.unchanged || 0),
    count_partial: Number(job.count_partial || 0) + (outcome === 'retry' ? 1 : Number(stats?.partial || 0)),
    count_failed: Number(job.count_failed || 0) + (outcome === 'failed' ? 1 : 0),
    count_dead_letter: Number(job.count_dead_letter || 0) + (outcome === 'dead_letter' ? 1 : 0),
    last_error_code: outcome === 'completed' ? null : undefined,
    updated_at: nowIso,
  };
  if (next.last_error_code === undefined) delete next.last_error_code;
  await sb(`hospital_collection_jobs?id=eq.${enc(job.id)}`, {
    method: 'PATCH', body: next, prefer: 'return=minimal',
  });
}

async function sourceBasis(sb, ykiho) {
  const path = `facility_sources?source_system=eq.${enc(DISCOVERY_SOURCE_SYSTEM)}` +
    `&external_id=eq.${enc(ykiho)}&select=external_id,raw&limit=1`;
  const row = (await sb(path)).data?.[0] || null;
  const basis = row?.raw?.basis;
  if (!row || row.external_id !== ykiho || !basis || typeof basis !== 'object' || Array.isArray(basis)) return null;
  return basis;
}

/**
 * 한 batch 에서 snapshot item 1개만 enrichment 한다.
 * 모든 식별자는 메모리에서만 사용하며, 반환값은 집계·상태 코드만 포함한다.
 */
export async function runEnrichmentItem(deps = {}) {
  const { sb, createClient, key } = deps;
  if (typeof sb !== 'function' || typeof createClient !== 'function') throw new Error('batch_config_invalid');
  const uuid = typeof deps.uuid === 'function' ? deps.uuid : randomUUID;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const nowMs = now();
  const nowIso = new Date(nowMs).toISOString();
  const owner = uuid();
  const collect = deps.collect ?? collectHospitals;
  const persist = deps.persist ?? persistCollected;
  const job = (await sb(activeJobPath())).data?.[0] || null;
  if (!job) return { ok: true, status: 'no_active_job', didWork: false, phase: 'done' };
  if (job.phase !== 'enrichment') return { ok: true, status: 'phase_complete', didWork: false, phase: job.phase || 'unknown' };
  if (shouldKeepDailyPause(job, nowMs)) return { ok: true, status: 'paused_for_today', didWork: false, phase: 'enrichment' };

  const acquired = await rpcBool(sb, 'hospital_collection_job_acquire_lease', {
    p_job_id: job.id, p_owner: owner, p_lease_seconds: ENRICHMENT_LEASE_SECONDS,
  });
  if (!acquired) return { ok: true, status: 'busy', didWork: false, phase: 'enrichment' };

  let releaseStatus = 'pending';
  let activeItem = null;
  let activeAttempt = 0;
  try {
    const item = await nextEligibleItem(sb, job.id, nowMs);
    if (!item) {
      await sb(`hospital_collection_jobs?id=eq.${enc(job.id)}`, {
        method: 'PATCH', body: { phase: 'done', last_error_code: null, updated_at: nowIso }, prefer: 'return=minimal',
      });
      releaseStatus = 'completed';
      return { ok: true, status: 'enrichment_complete', didWork: false, phase: 'done' };
    }

    const attempt = Number(item.attempt_count || 0) + 1;
    activeItem = item;
    activeAttempt = attempt;
    await markItem(sb, item.id, {
      status: 'processing', attempt_count: attempt, started_at: nowIso,
      next_retry_at: null, last_error_code: null, updated_at: nowIso,
    });

    const ykiho = ykihoFromFacilityId(item.facility_id);
    const basis = ykiho ? await sourceBasis(sb, ykiho) : null;
    if (!basis) {
      const dead = attempt >= ENRICHMENT_MAX_ATTEMPTS;
      await markItem(sb, item.id, {
        status: dead ? 'dead_letter' : 'retry_wait',
        last_error_code: ENRICHMENT_ERROR_CODES.sourceMissing,
        next_retry_at: dead ? null : retryAt(nowMs, attempt, false),
        completed_at: dead ? nowIso : null, updated_at: nowIso,
      });
      await patchJobCounters(sb, job, null, dead ? 'dead_letter' : 'retry', nowIso);
      return { ok: true, status: dead ? 'item_dead_letter' : 'item_retry', didWork: true, phase: 'enrichment' };
    }

    const cap = safeCap(deps.dailyCallCap);
    const reserveCall = async () => rpcBool(sb, 'hospital_hira_reserve_daily_calls', {
      p_calls: 1, p_requested_cap: cap,
    });
    const client = createClient({
      key,
      beforeAttempt: reserveCall,
      deadlineMs: Number.isFinite(deps.deadlineMs) ? deps.deadlineMs : nowMs + 40_000,
      now,
    });
    const collected = await collect(client, {
      maxInstitutions: 1,
      seededInstitutions: [{ ykiho, basis }],
      deadlineMs: Number.isFinite(deps.deadlineMs) ? deps.deadlineMs : nowMs + 40_000,
      now,
    });
    const persisted = await persist(collected._normalizedAll, { sb, now: () => nowIso });
    const completed = persisted.status === 'ok';
    const dead = !completed && attempt >= ENRICHMENT_MAX_ATTEMPTS;
    const outcome = completed ? 'completed' : (dead ? 'dead_letter' : 'retry');
    await markItem(sb, item.id, {
      status: completed ? 'completed' : (dead ? 'dead_letter' : 'retry_wait'),
      last_error_code: completed ? null : ENRICHMENT_ERROR_CODES.partial,
      next_retry_at: completed || dead ? null : retryAt(nowMs, attempt, false),
      completed_at: completed || dead ? nowIso : null,
      updated_at: nowIso,
    });
    await patchJobCounters(sb, job, persisted.stats, outcome, nowIso);
    return { ok: true, status: completed ? 'item_complete' : (dead ? 'item_dead_letter' : 'item_retry'), didWork: true, phase: 'enrichment' };
  } catch (error) {
    const paused = pausesToday(error);
    releaseStatus = paused ? 'paused_for_today' : 'pending';
    if (activeItem) {
      const dead = !paused && activeAttempt >= ENRICHMENT_MAX_ATTEMPTS;
      try {
        await markItem(sb, activeItem.id, {
          status: dead ? 'dead_letter' : 'retry_wait',
          last_error_code: safeFailureCode(error),
          next_retry_at: dead ? null : retryAt(nowMs, activeAttempt, paused),
          completed_at: dead ? nowIso : null,
          updated_at: nowIso,
        });
        await patchJobCounters(sb, job, null, dead ? 'dead_letter' : 'retry', nowIso);
      } catch { /* release/lease-expiry recovery remains available */ }
    }
    try {
      await sb(`hospital_collection_jobs?id=eq.${enc(job.id)}`, {
        method: 'PATCH', body: { last_error_code: safeFailureCode(error), updated_at: nowIso }, prefer: 'return=minimal',
      });
    } catch { /* lease expiry recovery remains available */ }
    if (paused) return { ok: true, status: 'paused_for_today', didWork: false, phase: 'enrichment' };
    throw error;
  } finally {
    try { await release(sb, job.id, owner, releaseStatus); } catch { /* lease expiry recovery remains available */ }
  }
}
