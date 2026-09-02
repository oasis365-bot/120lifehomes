// GET /api/env-check — 환경변수 "설정 여부"만 확인 (진단용).
//
//   · 비밀값·비밀값의 일부(앞자리/뒷자리/길이/부분문자열)를 절대 응답하지 않는다.
//   · CRON_SECRET 이 설정돼 있으면 ?secret=<CRON_SECRET> (또는 Bearer) 필요.
//     설정 전(부트스트랩)에는 인증 없이 응답하되, 응답에 비밀정보가 전혀 없으므로 안전.
export default function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const authed =
    !secret ||
    req.headers.authorization === `Bearer ${secret}` ||
    (req.query && req.query.secret === secret);
  if (!authed) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const has = (name) => Boolean(process.env[name] && String(process.env[name]).trim());

  // Supabase 키가 service_role 인지(= RLS 우회 가능) 여부만 boolean 으로.
  // 키 문자열/클레임은 응답하지 않는다.
  let supabaseKeyIsServiceRole = false;
  const sk = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  try {
    if (sk.startsWith('eyJ')) {
      const payload = JSON.parse(Buffer.from(sk.split('.')[1] || '', 'base64').toString());
      supabaseKeyIsServiceRole = payload.role === 'service_role';
    } else if (sk.startsWith('sb_secret_')) {
      supabaseKeyIsServiceRole = true; // 신형 secret 키
    }
    // sb_publishable_ / anon / 기타 → false
  } catch {
    supabaseKeyIsServiceRole = false;
  }

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    supabase_url:                 { configured: has('SUPABASE_URL') },
    supabase_service_role_key:    { configured: has('SUPABASE_SERVICE_ROLE_KEY'), is_service_role: supabaseKeyIsServiceRole },
    data_go_kr_key:               { configured: has('DATA_GO_KR_KEY') },
    cron_secret:                  { configured: has('CRON_SECRET') },
    db_ready: has('SUPABASE_URL') && has('SUPABASE_SERVICE_ROLE_KEY') && supabaseKeyIsServiceRole,
  });
}
