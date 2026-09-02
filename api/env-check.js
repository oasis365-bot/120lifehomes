// GET /api/env-check — 필수 환경변수의 "설정 여부"만 확인 (운영 진단용).
//
//   보안 원칙:
//     · 비밀값 자체는 물론, 비밀값의 일부/길이/앞뒤 문자열도 절대 반환하지 않는다.
//     · Supabase 키 role 문자열, Node 버전 등 불필요한 내부정보도 반환하지 않는다.
//     · 인증된 응답도 configured(true/false) 와 db_ready 만.
//
//   인증:
//     · Authorization: Bearer <CRON_SECRET>  (권장 — 쿼리스트링은 URL/로그에 남음)
//     · ?secret=<CRON_SECRET>                (호환용, 비권장)
//     · CRON_SECRET 이 설정돼 있으면 항상 인증 필요.
//     · CRON_SECRET 미설정 시: 운영(VERCEL_ENV=production)에서는 절대 공개하지 않음(404).
//       비운영 환경에서만 부트스트랩 목적 무인증 허용.
import { timingSafeEqual } from 'node:crypto';

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

export default function handler(req, res) {
  const isProd = process.env.VERCEL_ENV === 'production';
  const secret = process.env.CRON_SECRET || '';

  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const qsecret =
    req.query && typeof req.query.secret === 'string' ? req.query.secret : '';
  const provided = bearer || qsecret;

  let authed;
  if (secret) {
    authed = safeEqual(provided, secret);
  } else {
    // CRON_SECRET 미설정: 운영에서는 공개 금지, 비운영에서만 허용
    authed = !isProd;
  }

  if (!authed) {
    // 운영에서는 엔드포인트 존재를 드러내지 않도록 404
    if (isProd) {
      res.status(404).json({ error: 'not_found' });
    } else {
      res.status(401).json({ error: 'unauthorized' });
    }
    return;
  }

  const has = (name) =>
    Boolean(process.env[name] && String(process.env[name]).trim());

  // Supabase 키가 RLS 를 우회할 수 있는 종류인지 "내부적으로만" 판단해 db_ready 에 반영.
  // 판단 결과(role 문자열 등)는 응답에 넣지 않는다.
  let supabaseKeyUsable = false;
  const sk = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  try {
    if (sk.startsWith('eyJ')) {
      const payload = JSON.parse(
        Buffer.from(sk.split('.')[1] || '', 'base64').toString('utf8')
      );
      supabaseKeyUsable = payload.role === 'service_role';
    } else if (sk.startsWith('sb_secret_')) {
      supabaseKeyUsable = true;
    }
    // sb_publishable_ / anon / 기타 → false
  } catch {
    supabaseKeyUsable = false;
  }

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    supabase_url: { configured: has('SUPABASE_URL') },
    supabase_service_role_key: { configured: has('SUPABASE_SERVICE_ROLE_KEY') },
    data_go_kr_key: { configured: has('DATA_GO_KR_KEY') },
    cron_secret: { configured: has('CRON_SECRET') },
    db_ready:
      has('SUPABASE_URL') &&
      has('SUPABASE_SERVICE_ROLE_KEY') &&
      supabaseKeyUsable,
  });
}
