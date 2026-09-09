// GET /api/env-check — 필수 환경변수의 "설정 여부" + 실제 DB 접근 가능 여부 확인 (진단용).
//
//   보안 원칙:
//     · 비밀값 자체는 물론, 비밀값의 일부/길이/앞뒤 문자열/접두사도 절대 반환하지 않는다.
//     · Supabase 서버 키가 SUPABASE_SECRET_KEY 로 왔는지 SUPABASE_SERVICE_ROLE_KEY 로 왔는지도
//       응답에 드러내지 않는다 (통합 지표 하나만).
//     · Supabase 키 role 문자열, Node 버전 등 불필요한 내부정보도 반환하지 않는다.
//     · 인증된 응답도 configured(true/false) 와 db_ready 만.
//
//   서버 키 (lib/db.js 와 동일 규칙):
//     · SUPABASE_SECRET_KEY (신규 sb_secret_...) 우선, 없으면 SUPABASE_SERVICE_ROLE_KEY (legacy JWT) fallback.
//
//   db_ready:
//     · "형식 판단" 이 아니라 실제로 feature_flags 를 1행 select 해봐서 성공하면 true.
//       (읽기 전용 · 데이터는 응답에 넣지 않음)
//
//   인증:
//     · Authorization: Bearer <CRON_SECRET>  (권장)
//     · ?secret=<CRON_SECRET>                (호환용, 비권장)
//     · CRON_SECRET 이 설정돼 있으면 항상 인증 필요.
//     · CRON_SECRET 미설정 시: 운영(VERCEL_ENV=production)에서는 404, 비운영에서만 무인증 허용.
import { timingSafeEqual } from 'node:crypto';
import { resolveServerKey, classifyServerKey, sb } from '../lib/db.js';

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length === 0 || ba.length !== bb.length) return false;
  try {
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

// 실제 DB 접근 1회 (읽기 전용, 데이터 미반환). 성공하면 true.
async function defaultDbPing(env) {
  try {
    await sb('feature_flags?select=key&limit=1', {}, { env, timeoutMs: 3000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {object} [deps]
 * @param {NodeJS.ProcessEnv} [deps.env]
 * @param {(env:object)=>Promise<boolean>} [deps.dbPing]
 */
export function createHandler(deps = {}) {
  const env = deps.env || process.env;
  const dbPing = deps.dbPing || defaultDbPing;

  return async function handler(req, res) {
    const isProd = env.VERCEL_ENV === 'production';
    const secret = env.CRON_SECRET || '';

    const bearer = (req.headers?.authorization || '').replace(/^Bearer\s+/i, '').trim();
    const qsecret =
      req.query && typeof req.query.secret === 'string' ? req.query.secret : '';
    const provided = bearer || qsecret;

    const authed = secret ? safeEqual(provided, secret) : !isProd;
    if (!authed) {
      if (isProd) res.status(404).json({ error: 'not_found' });
      else res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const has = (name) => Boolean(env[name] && String(env[name]).trim());

    // 서버 키: SECRET_KEY 우선 / SERVICE_ROLE_KEY fallback → 어느 쪽인지는 노출 안 함
    const { key: serverKey } = resolveServerKey(env);
    const cls = classifyServerKey(serverKey);
    const serverKeyConfigured = Boolean(serverKey);

    let dbReady = false;
    if (has('SUPABASE_URL') && cls.usable) {
      dbReady = await dbPing(env); // 실제 접근 확인
    }

    res.setHeader?.('Cache-Control', 'no-store');
    res.status(200).json({
      supabase_url: { configured: has('SUPABASE_URL') },
      supabase_server_key: { configured: serverKeyConfigured }, // SECRET_KEY 또는 SERVICE_ROLE_KEY (어느 쪽인지 미노출)
      data_go_kr_key: { configured: has('DATA_GO_KR_KEY') },
      cron_secret: { configured: has('CRON_SECRET') },
      db_ready: dbReady, // 실제 DB read 성공 여부
    });
  };
}

export default createHandler();
