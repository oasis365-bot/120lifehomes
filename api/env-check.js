// GET /api/env-check — 환경변수 존재/형태 확인 (비밀값 자체는 노출 안 함). 진단용.
export default function handler(req, res) {
  const k = process.env.DATA_GO_KR_KEY || '';
  const dataKeyMask = k ? `${k.slice(0, 6)}…${k.slice(-4)} (len ${k.length})` : null;

  // Supabase 키의 role 클레임만 확인 (JWT payload 의 role 은 비밀 아님)
  let supabaseRole = null;
  const sk = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  try {
    if (sk.startsWith('eyJ')) {
      const payload = JSON.parse(Buffer.from(sk.split('.')[1], 'base64').toString());
      supabaseRole = payload.role || null;
    } else if (sk.startsWith('sb_secret_')) {
      supabaseRole = 'sb_secret (신형 secret)';
    } else if (sk.startsWith('sb_publishable_')) {
      supabaseRole = 'sb_publishable (신형 publishable — RLS 우회 불가!)';
    } else if (sk) {
      supabaseRole = 'unknown format';
    }
  } catch {
    supabaseRole = 'decode failed';
  }

  res.status(200).json({
    SUPABASE_URL: Boolean(process.env.SUPABASE_URL),
    SUPABASE_SERVICE_ROLE_KEY: Boolean(sk),
    SUPABASE_key_role: supabaseRole, // "service_role" 이어야 함
    DATA_GO_KR_KEY: dataKeyMask,
    CRON_SECRET: Boolean(process.env.CRON_SECRET),
    node: process.version,
    now: new Date().toISOString(),
  });
}
