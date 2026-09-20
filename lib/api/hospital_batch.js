// POST /api/hospital/batch — Preview 전용 전국 요양병원 discovery 1페이지 처리.
import { timingSafeEqual } from 'node:crypto';
import { createHiraClient, HiraError } from '../hira/client.js';
import { runDiscoveryPage } from '../hira/batch_discovery.js';
import { runEnrichmentItem } from '../hira/batch_enrichment.js';
import { assertPreviewDb } from '../hira/persist.js';
import { sb as realSb } from '../db.js';

export const config = { maxDuration: 60 };
const GUARD_REASONS = new Set([
  'no_sb', 'production_env', 'wrong_preview_db', 'facilities_query_failed',
  'ltc_count_unknown', 'db_has_ltc_rows', 'schema_incomplete', 'flags_query_failed',
  'flag_missing', 'hospital_module_on',
]);
const RESULT_STATUSES = new Set([
  'busy', 'paused_for_today', 'page_complete', 'snapshot_complete', 'phase_complete',
  'no_active_job', 'enrichment_complete', 'item_complete', 'item_retry', 'item_dead_letter',
  'retry_later',
]);
const RESULT_PHASES = new Set(['discovery', 'enrichment', 'done', 'unknown']);

function safeEqual(a, b) {
  const A = Buffer.from(String(a || ''), 'utf8');
  const B = Buffer.from(String(b || ''), 'utf8');
  if (!A.length || A.length !== B.length) return false;
  try { return timingSafeEqual(A, B); } catch { return false; }
}

function validEmptyBody(body) {
  return body === undefined || (
    body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0
  );
}

function publicResult(result) {
  if (!result || result.ok !== true || !RESULT_STATUSES.has(result.status) ||
      typeof result.didWork !== 'boolean' || !RESULT_PHASES.has(result.phase)) {
    throw new Error('batch_result_invalid');
  }
  const out = { ok: true, status: result.status, didWork: result.didWork, phase: result.phase };
  for (const key of ['page', 'added', 'snapshotCount', 'totalEstimated']) {
    const value = result[key];
    if (value === null) out[key] = null;
    else if (Number.isInteger(value) && value >= 0) out[key] = value;
  }
  return out;
}

export function createHandler(deps = {}) {
  const env = deps.env ?? process.env;
  const sb = deps.sbImpl ?? realSb;
  const assertDb = deps.assertDb ?? assertPreviewDb;
  const createClient = deps.createClient ?? createHiraClient;
  // `run`은 기존 discovery 단위 테스트 호환용 별칭이다.
  const runDiscovery = deps.runDiscovery ?? deps.run ?? runDiscoveryPage;
  const runEnrichment = deps.runEnrichment ?? runEnrichmentItem;

  return async function handler(req, res) {
    // 어떤 입력보다 production 404가 우선한다.
    if (env.VERCEL_ENV === 'production') {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (String(req.method || 'GET').toUpperCase() !== 'POST') {
      res.setHeader?.('Allow', 'POST');
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }
    const match = /^Bearer\s+(.+)$/i.exec(req.headers?.authorization || '');
    const bearer = match ? match[1].trim() : '';
    if (!env.CRON_SECRET || !safeEqual(bearer, env.CRON_SECRET)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    res.setHeader?.('Cache-Control', 'no-store');
    if (!validEmptyBody(req.body)) {
      res.status(400).json({ error: 'invalid_body' });
      return;
    }
    if (env.HOSPITAL_BATCH_ENABLED !== '1') {
      res.status(501).json({ error: 'batch_disabled' });
      return;
    }
    if (!String(env.DATA_GO_KR_KEY || '').trim()) {
      res.status(503).json({ error: 'hira_key_not_configured' });
      return;
    }

    let guard;
    try {
      guard = await assertDb({
        sb,
        env: { ...env, HOSPITAL_INGEST_DB_HOST: env.HOSPITAL_BATCH_DB_HOST || '' },
      });
    } catch {
      res.status(500).json({ error: 'db_guard_failed' });
      return;
    }
    if (!guard?.ok) {
      const reason = GUARD_REASONS.has(guard?.reason) ? guard.reason : 'unknown';
      res.status(409).json({ error: 'unsafe_db', reason });
      return;
    }

    try {
      const runDeps = {
        sb,
        createClient: (opt) => createClient({
          ...opt,
          key: env.DATA_GO_KR_KEY,
          deadlineMs: (deps.now ?? Date.now)() + 40_000,
          now: deps.now,
        }),
        key: env.DATA_GO_KR_KEY,
        dailyCallCap: env.HIRA_DAILY_CALL_CAP,
        now: deps.now,
        uuid: deps.uuid,
      };
      const discovery = await runDiscovery(runDeps);
      // discovery 마지막 페이지가 phase를 넘긴 직후에만 같은 요청에서 1기관을 처리한다.
      // 이후 요청은 runDiscovery가 phase_complete를 반환하므로 enrichment만 수행한다.
      const result = discovery.status === 'phase_complete' && discovery.phase === 'enrichment'
        ? await runEnrichment(runDeps)
        : discovery;
      res.status(200).json(publicResult(result));
    } catch (e) {
      const status = e instanceof HiraError && e.reason === 'deadline' ? 503 : 502;
      res.status(status).json({ error: 'batch_failed' });
    }
  };
}

export default createHandler();
