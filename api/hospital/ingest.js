// =====================================================================
// GET /api/hospital/ingest — 요양병원 수집 (dry-run) + (1B-3B) Preview 시험 적재
// =====================================================================
//  · production(VERCEL_ENV=production) → 404
//  · CRON_SECRET Bearer 인증 필수 (timingSafeEqual). 없거나 틀리면 401.
//  · 기본 dryRun=true : HIRA 수집 → 정규화 → 통계·경고·샘플3. DB write 0.
//  · dryRun=false (실 적재):
//      - HOSPITAL_INGEST_PERSIST 환경변수 = '1' 이 아니면 → 501 (1B-3A 에서는 비활성)
//      - assertPreviewDb() 로 "Preview 전용 빈 DB" 확인. 운영 Supabase / hospital_module ON 이면 중단
//      - limit 최대 3
//  · DATA_GO_KR_KEY / CRON_SECRET / DB URL / ykiho 원문 을 응답·로그에 출력하지 않음.
//
//  쿼리:
//    ?limit=<1..3>    수집 기관 수 (기본 3, 상한 3)
//    ?dryRun=false    실 적재 (HOSPITAL_INGEST_PERSIST=1 + Preview DB 확인 필요)
//    ?secret=         (Bearer 대신 호환용)
// =====================================================================
import { timingSafeEqual } from 'node:crypto';
import { createHiraClient, HiraError } from '../../lib/hira/client.js';
import { collectHospitals } from '../../lib/hira/collect.js';
import { persistCollected, assertPreviewDb } from '../../lib/hira/persist.js';
import { sb as realSb } from '../../lib/db.js';

export const config = { maxDuration: 60 };

const LIMIT_MAX = 3;

function safeEqual(a, b) {
  const A = Buffer.from(String(a || ''), 'utf8');
  const B = Buffer.from(String(b || ''), 'utf8');
  if (A.length === 0 || A.length !== B.length) return false;
  try {
    return timingSafeEqual(A, B);
  } catch {
    return false;
  }
}

const scrubToken = (s) => String(s).replace(/[A-Za-z0-9+/]{40,}={0,2}/g, '***');

/**
 * @param {Object} deps
 * @param {typeof createHiraClient} [deps.createClient]
 * @param {typeof collectHospitals} [deps.collect]
 * @param {Function} [deps.sbImpl]        lib/db.js 의 sb (실 적재/안전점검용)
 * @param {typeof persistCollected} [deps.persist]
 * @param {typeof assertPreviewDb} [deps.assertDb]
 * @param {NodeJS.ProcessEnv} [deps.env]
 */
export function createHandler(deps = {}) {
  const createClient = deps.createClient ?? createHiraClient;
  const collect = deps.collect ?? collectHospitals;
  const persist = deps.persist ?? persistCollected;
  const assertDb = deps.assertDb ?? assertPreviewDb;
  const sbImpl = deps.sbImpl ?? realSb;
  const env = deps.env ?? process.env;

  return async function handler(req, res) {
    if (env.VERCEL_ENV === 'production') {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const secret = env.CRON_SECRET || '';
    const bearer = (req.headers?.authorization || '').replace(/^Bearer\s+/i, '').trim();
    const qsecret = req.query && typeof req.query.secret === 'string' ? req.query.secret : '';
    if (!secret || !safeEqual(bearer || qsecret, secret)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    res.setHeader?.('Cache-Control', 'no-store');
    const q = req.query || {};
    const wantPersist = String(q.dryRun) === 'false';
    const limit = Math.min(Math.max(parseInt(q.limit, 10) || LIMIT_MAX, 1), LIMIT_MAX);

    // ── dryRun=false (실 적재) ────────────────────────────────────────
    if (wantPersist) {
      if (env.HOSPITAL_INGEST_PERSIST !== '1') {
        res.status(501).json({
          error: 'persist_disabled',
          phase: '1B-3A',
          note: 'dryRun=false 실적재는 1B-3B. Preview 환경에 HOSPITAL_INGEST_PERSIST=1 설정 후 활성화.',
        });
        return;
      }

      // 운영 Supabase / hospital_module ON / 스키마 미완 이면 무조건 중단
      let guard;
      try {
        guard = await assertDb({ sb: sbImpl, env });
      } catch (e) {
        res.status(500).json({ error: 'db_guard_failed', detail: scrubToken(String(e && e.message).slice(0, 160)) });
        return;
      }
      if (!guard || !guard.ok) {
        res.status(409).json({ error: 'unsafe_db', reason: guard ? guard.reason : 'unknown' });
        return;
      }

      const key = env.DATA_GO_KR_KEY || '';
      if (!key.trim()) {
        res.status(503).json({ error: 'DATA_GO_KR_KEY_not_configured' });
        return;
      }

      try {
        const client = createClient({ key });
        const result = await collect(client, { maxInstitutions: limit, pageSize: 100 });
        const { _normalizedAll, ...safe } = result;
        const items = Array.isArray(_normalizedAll) ? _normalizedAll : [];

        const collectedCount = Number.isFinite(result?.stats?.deduped) ? result.stats.deduped : null;
        const normalizedCount = Number.isFinite(result?.stats?.normalized) ? result.stats.normalized : null;
        const persistInputCount = items.length;

        // ── fail-closed (1) : 기대 수집 수(limit) 만큼 정규화되지 않으면 persist 미호출 ──
        //   HIRA 목록이 정상 resultCode 로 0건을 반환하는 data.go.kr 간헐 장애 대비.
        //   시설/프로필/소스에 아무것도 쓰지 않는다.
        if (persistInputCount !== limit) {
          res.status(422).json({
            error: 'collect_count_mismatch',
            dryRun: false,
            expected: limit,
            collectedCount,
            normalizedCount,
            persistInputCount,
            warnings: Array.isArray(safe.warnings) ? safe.warnings.length : 0,
          });
          return;
        }

        const persisted = await persist(items, { sb: sbImpl, env });
        const st = persisted.stats || {};
        const writeSum =
          (st.new || 0) + (st.updated || 0) + (st.unchanged || 0) + (st.partial || 0) + (st.failed || 0);

        // ── fail-closed (2) : 저장 결과 합계가 입력 수와 안 맞거나 persist 가 failed 면 성공 아님 ──
        if (persisted.status === 'failed' || writeSum !== persistInputCount) {
          res.status(500).json({
            error: 'persist_count_mismatch',
            dryRun: false,
            persistStatus: persisted.status,
            persistInputCount,
            writeSum,
            runId: persisted.runId,
          });
          return;
        }

        res.status(200).json({
          ok: true,
          dryRun: false,
          runId: persisted.runId,
          persisted: persisted.stats,
          persistStatus: persisted.status,
          collectedCount,
          normalizedCount,
          persistInputCount,
          failures: persisted.failures, // ykiho 마스킹됨
          ...safe,
        });
      } catch (e) {
        res.status(502).json({
          error: 'ingest_failed',
          detail: scrubToken(String((e && e.message) || e).slice(0, 200)),
        });
      }
      return;
    }

    // ── dryRun=true (기본) : DB write 0 ─────────────────────────────
    const key = env.DATA_GO_KR_KEY || '';
    if (!key.trim()) {
      res.status(503).json({ error: 'DATA_GO_KR_KEY_not_configured' });
      return;
    }

    try {
      const client = createClient({ key });
      const result = await collect(client, { maxInstitutions: limit, pageSize: 100 });
      const { _normalizedAll, ...safe } = result;
      res.status(200).json({ ok: true, dryRun: true, dbWrites: 0, ...safe });
    } catch (e) {
      const info =
        e instanceof HiraError
          ? { reason: e.reason, op: e.op, attempts: e.attempts, lastStatus: e.lastStatus, lastResultCode: e.lastResultCode }
          : {};
      res.status(502).json({
        error: 'collect_failed',
        detail: scrubToken(String((e && e.message) || e).slice(0, 200)),
        ...info,
      });
    }
  };
}

export default createHandler();
