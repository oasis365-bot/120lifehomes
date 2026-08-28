// GET /api/env-check — 환경변수 존재 여부만 확인 (값은 노출하지 않음). 진단용.
export default function handler(req, res) {
  res.status(200).json({
    SUPABASE_URL: Boolean(process.env.SUPABASE_URL),
    SUPABASE_SERVICE_ROLE_KEY: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    DATA_GO_KR_KEY: Boolean(process.env.DATA_GO_KR_KEY),
    CRON_SECRET: Boolean(process.env.CRON_SECRET),
    node: process.version,
    now: new Date().toISOString(),
  });
}
