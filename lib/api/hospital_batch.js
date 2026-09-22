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
// 요청 1회에서 enrichment item 을 여러 개 이어서 처리한다. Vercel maxDuration(60s)
// 안에서 여유를 두고, item 수 상한도 별도로 둬 시간 추정이 빗나가도 한 요청이
// 지나치게 오래 걸리지 않게 한다. 일일 HIRA 호출 한도 자체는 이 값과 무관하게
// hospital_hira_reserve_daily_calls RPC 가 원자적으로 강제한다 — 여기서는 그 한도에
// 도달해 runEnrichment 가 didWork:false 를 반환하면 즉시 멈출 뿐이다.
const ENRICHMENT_BATCH_DEADLINE_MS = 45_000;
const ENRICHMENT_BATCH_MAX_ITEMS = 200;

// item 하나는 runEnrichment 자체의 acquire_lease→처리→release_lease 로 완결되므로,
// 여기서는 그 사이클을 순차적으로(동시 실행 없이) 반복 호출하기만 한다 — 동시에 두
// 항목을 처리하지 않으므로 중복 처리 위험이 새로 생기지 않는다. didWork:false
// (busy/paused_for_today/enrichment_complete/phase_complete)면 더 할 일이 없다는
// 뜻이라 즉시 멈춘다.
async function runEnrichmentBatch(runEnrichment, runDeps, opt = {}) {
  const now = typeof opt.now === 'function' ? opt.now : Date.now;
  const deadlineMs = now() + (Number.isFinite(opt.batchDeadlineMs) ? opt.batchDeadlineMs : ENRICHMENT_BATCH_DEADLINE_MS);
  const maxItems = Number.isFinite(opt.batchMaxItems) ? opt.batchMaxItems : ENRICHMENT_BATCH_MAX_ITEMS;
  const summary = { attempted: 0, completed: 0, retried: 0, deadLettered: 0 };
  let last = { ok: true, status: 'enrichment_complete', didWork: false, phase: 'enrichment' };
  for (let i = 0; i < maxItems && now() < deadlineMs; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- item마다 lease를 잡았다 놓아야 해 순차 실행이 필수.
    last = await runEnrichment(runDeps);
    if (!last?.didWork) break;
    summary.attempted += 1;
    if (last.status === 'item_complete') summary.completed += 1;
    else if (last.status === 'item_retry') summary.retried += 1;
    else if (last.status === 'item_dead_letter') summary.deadLettered += 1;
  }
  return { last, summary };
}

function safeEqual(a, b) {
  const A = Buffer.from(String(a || ''), 'utf8');
  const B = Buffer.from(String(b || ''), 'utf8');
  if (!A.length || A.length !== B.length) return false;
  try { return timingSafeEqual(A, B); } catch { return false; }
}

// 기본 계약은 여전히 "빈 JSON object만 허용, 실행 파라미터 주입 거부"다. 유일한
// 예외는 singleItemTest:true 하나뿐이며, 이것도 무엇을(WHAT) 하는지는 전혀
// 바꾸지 못하고 이번 요청 1회의 enrichment item 처리 개수를 1개로 줄이기만
// 한다(항상 기본값 이하로만 좁힘 — 절대 넓히지 않음, 어느 기관인지도 선택 못함).
// 인증(CRON_SECRET)을 통과한 호출자만 도달하는 지점이라, 수동 1회 시험을 "최대
// 45초"라는 시간 추정이 아니라 개수로 못박기 위한 좁은 허용이다.
function parseRequestBody(body) {
  if (body === undefined) return { ok: true, singleItemTest: false };
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const keys = Object.keys(body);
    if (keys.length === 0) return { ok: true, singleItemTest: false };
    if (keys.length === 1 && keys[0] === 'singleItemTest' && body.singleItemTest === true) {
      return { ok: true, singleItemTest: true };
    }
  }
  return { ok: false, singleItemTest: false };
}

function publicResult(result) {
  if (!result || result.ok !== true || !RESULT_STATUSES.has(result.status) ||
      typeof result.didWork !== 'boolean' || !RESULT_PHASES.has(result.phase)) {
    throw new Error('batch_result_invalid');
  }
  const out = { ok: true, status: result.status, didWork: result.didWork, phase: result.phase };
  for (const key of [
    'page', 'added', 'snapshotCount', 'totalEstimated',
    'attempted', 'completed', 'retried', 'deadLettered',
  ]) {
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
    const bodyParsed = parseRequestBody(req.body);
    if (!bodyParsed.ok) {
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
      // discovery 마지막 페이지가 phase를 넘긴 직후에만 같은 요청에서 enrichment를 수행한다.
      // 이후 요청은 runDiscovery가 phase_complete를 반환하므로 매번 enrichment로 들어간다.
      // enrichment는 item 하나씩 완결되는 단위라, 시간·개수 예산 안에서 여러 개를
      // 이어서 처리해 "한 번 호출 = 기관 1곳"이던 처리량 제약을 완화한다.
      let result;
      if (discovery.status === 'phase_complete' && discovery.phase === 'enrichment') {
        const { last, summary } = await runEnrichmentBatch(runEnrichment, runDeps, {
          now: deps.now,
          batchDeadlineMs: deps.enrichmentBatchDeadlineMs,
          // singleItemTest는 시간 예산과 무관하게 반복 횟수 자체를 1로 못박는다.
          batchMaxItems: bodyParsed.singleItemTest ? 1 : deps.enrichmentBatchMaxItems,
        });
        result = { ...last, ...summary };
      } else {
        result = discovery;
      }
      res.status(200).json(publicResult(result));
    } catch (e) {
      const status = e instanceof HiraError && e.reason === 'deadline' ? 503 : 502;
      res.status(status).json({ error: 'batch_failed' });
    }
  };
}

export default createHandler();
