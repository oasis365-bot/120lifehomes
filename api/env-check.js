// GET /api/env-check — 환경변수 존재/길이 확인 (값 자체는 노출하지 않음). 진단용.
export default function handler(req, res) {
  const k = process.env.DATA_GO_KR_KEY || '';
  const mask = k ? `${k.slice(0, 6)}…${k.slice(-4)} (len ${k.length}, ${k.includes('%') ? 'Encoding형' : 'Decoding형'})` : null;
  res.status(200).json({
    SUPABASE_URL: Boolean(process.env.SUPABASE_URL),
    SUPABASE_SERVICE_ROLE_KEY: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    DATA_GO_KR_KEY: Boolean(process.env.DATA_GO_KR_KEY),
    DATA_GO_KR_KEY_preview: mask,
    CRON_SECRET: Boolean(process.env.CRON_SECRET),
    node: process.version,
    now: new Date().toISOString(),
  });
}
