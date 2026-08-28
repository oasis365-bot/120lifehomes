// Supabase REST(PostgREST) 얇은 래퍼 — 의존성 없이 fetch 만 사용.
// 서버(Vercel 함수)에서만 import 하세요. service_role 키를 씁니다.

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export function haveDb() {
  return Boolean(URL && KEY);
}

/**
 * @param {string} path  예: 'facilities?sido=eq.서울&limit=20'
 * @param {object} opt   { method, body, prefer, headers }
 * @returns {Promise<{data:any, count:number|null}>}
 */
export async function sb(path, opt = {}) {
  if (!haveDb()) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 미설정');
  const { method = 'GET', body, prefer, headers = {} } = opt;

  const res = await fetch(`${URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    throw new Error(`Supabase ${res.status} ${path} :: ${text.slice(0, 500)}`);
  }

  // Prefer: count=exact 이면 Content-Range: 0-19/1234 형태
  let count = null;
  const cr = res.headers.get('content-range');
  if (cr && cr.includes('/')) {
    const n = Number(cr.split('/')[1]);
    if (!Number.isNaN(n)) count = n;
  }
  return { data, count };
}
