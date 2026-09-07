// =====================================================================
// GET /api/hospital/ingest — 요양병원 수집 dry-run (Preview 전용, 1B-2)
// =====================================================================
//  · production(VERCEL_ENV=production) → 404
//  · CRON_SECRET Bearer 인증 필수 (timingSafeEqual). 없거나 틀리면 401.
//  · dryRun 기본 true. 1B-2 에서는 DB write 경로를 아예 구현하지 않음
//      → dryRun=false 로 불러도 write 하지 않고 501(not_implemented) 반환.
//  · 응답 = 통계 + 경고 + 정규화 예시 최대 3건 (ykiho·raw 원본 제외).
//  · 테스트 시 최대 20개 기관. 1,280곳 전체 수집 금지.
//  · DATA_GO_KR_KEY / CRON_SECRET 은 서버 환경변수에서만. 값·URL 을 로그/오류에 노출하지 않음.
//
//  쿼리:
//    ?limit=<1..20>   수집할 기관 수 (기본 3, 상한 20)
//    ?dryRun=false    (무시됨 — write 미구현, 501)
//    ?secret=         (Bearer 대신 호환용)
//
//  ⚠️ 실행시간: 기관당 API 호출 ≈ 7회(상세 6 + 평가 1) + 요청 간 최소 250ms.
//     limit=3 → ~22회 → 250ms 페이싱 5.5s + 지연 ≈ 25~35s (60s 안).
//     limit=20 → ~141회 → 페이싱만 35s + 지연 → 60s 초과 위험. 전량(1,280)은 절대 단일 호출 금지.
//     → 1B-3 전체 수집은 배치·체크포인트·재시작 구조 필요 (enrich.js 패턴).
// =====================================================================
import { timingSafeEqual } from 'node:crypto';
import { createHiraClient, HiraError } from '../../lib/hira/client.js';
import { collectHospitals, MAX_INSTITUTIONS_HARD_CAP } from '../../lib/hira/collect.js';

export const config = { maxDuration: 60 };

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

const scrubToken = (s) =>
  String(s).replace(/[A-Za-z0-9+/]{40,}={0,2}/g, '***');

/**
 * @param {Object} deps
 * @param {typeof createHiraClient} [deps.createClient]
 * @param {typeof collectHospitals} [deps.collect]
 * @param {NodeJS.ProcessEnv} [deps.env]
 */
export function createHandler(deps = {}) {
  const createClient = deps.createClient ?? createHiraClient;
  const collect = deps.collect ?? collectHospitals;
  const env = deps.env ?? process.env;

  return async function handler(req, res) {
    if (env.VERCEL_ENV === 'production') {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const secret = env.CRON_SECRET || '';
    const bearer = (req.headers?.authorization || '').replace(/^Bearer\s+/i, '').trim();
    const qsecret =
      req.query && typeof req.query.secret === 'string' ? req.query.secret : '';
    if (!secret || !safeEqual(bearer || qsecret, secret)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    res.setHeader?.('Cache-Control', 'no-store');
    const q = req.query || {};

    if (String(q.dryRun) === 'false') {
      res.status(501).json({
        error: 'db_write_not_implemented',
        note: '1B-2 는 dry-run 전용. DB 적재는 1B-3 에서 별도 승인 후 구현.',
      });
      return;
    }

    const key = env.DATA_GO_KR_KEY || '';
    if (!key.trim()) {
      res.status(503).json({ error: 'DATA_GO_KR_KEY_not_configured' });
      return;
    }

    const limit = Math.min(
      Math.max(parseInt(q.limit, 10) || 3, 1),
      MAX_INSTITUTIONS_HARD_CAP
    );

    try {
      const client = createClient({ key });
      const result = await collect(client, { maxInstitutions: limit, pageSize: 100 });
      const { _normalizedAll, ...safe } = result;
      res.status(200).json({ ok: true, dryRun: true, dbWrites: 0, ...safe });
    } catch (e) {
      const info =
        e instanceof HiraError
          ? {
              reason: e.reason,
              op: e.op,
              attempts: e.attempts,
              lastStatus: e.lastStatus,
              lastResultCode: e.lastResultCode,
            }
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
