// Supabase REST(PostgREST) 얇은 래퍼 — 의존성 없이 fetch 만 사용.
// 서버(Vercel 함수)에서만 import 하세요.
//
// 서버 키 (우선순위):
//   1) SUPABASE_SECRET_KEY          — 신규 API 키 (sb_secret_...). JWT 아님.
//   2) SUPABASE_SERVICE_ROLE_KEY    — legacy service_role JWT (eyJ...) [fallback]
//
// 헤더 처리 (공식 문서 기준):
//   · apikey          : 선택된 서버 키를 항상 설정
//   · Authorization   : legacy service_role JWT 일 때만  `Bearer <jwt>`  설정.
//                       신규 sb_secret_ 키는 Authorization 에 넣지 않는다 (apikey 만).
//   · sb_publishable_ / anon·authenticated JWT 등 낮은 권한 키는 거부.
//
// 키 원문·일부·길이는 로그·오류에 절대 출력하지 않는다.

function b64urlDecode(seg) {
  return Buffer.from(String(seg || ''), 'base64url').toString('utf8');
}

/**
 * 두 환경변수 중 실제로 쓸 서버 키를 고른다.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ key: string, source: 'SUPABASE_SECRET_KEY'|'SUPABASE_SERVICE_ROLE_KEY'|null }}
 */
export function resolveServerKey(env = process.env) {
  const secret = String(env.SUPABASE_SECRET_KEY || '').trim();
  if (secret) return { key: secret, source: 'SUPABASE_SECRET_KEY' };
  const legacy = String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (legacy) return { key: legacy, source: 'SUPABASE_SERVICE_ROLE_KEY' };
  return { key: '', source: null };
}

/**
 * 서버 키 형식 분류. (반환값에 키 원문·길이 없음)
 * @param {string} key
 * @returns {{ kind: string, usable: boolean, useBearer: boolean }}
 *   kind: 'missing' | 'new_secret' | 'new_publishable' | 'legacy_service_role'
 *         | 'legacy_<role>' | 'legacy_unparseable' | 'unknown'
 *   usable   : PostgREST 를 service 권한으로 호출 가능한가
 *   useBearer: Authorization: Bearer 헤더에 이 키를 넣어야 하는가 (legacy JWT 만 true)
 */
export function classifyServerKey(key) {
  const k = String(key || '');
  if (!k) return { kind: 'missing', usable: false, useBearer: false };

  // 신규 API 키 (JWT 아님)
  if (k.startsWith('sb_secret_')) return { kind: 'new_secret', usable: true, useBearer: false };
  if (k.startsWith('sb_publishable_')) return { kind: 'new_publishable', usable: false, useBearer: false };

  // legacy JWT
  if (k.startsWith('eyJ')) {
    let role = null;
    try {
      const payload = JSON.parse(b64urlDecode(k.split('.')[1]));
      role = payload && typeof payload.role === 'string' ? payload.role : null;
    } catch {
      role = null;
    }
    if (role === 'service_role') return { kind: 'legacy_service_role', usable: true, useBearer: true };
    if (role) return { kind: `legacy_${role}`, usable: false, useBearer: false }; // anon / authenticated 등
    return { kind: 'legacy_unparseable', usable: false, useBearer: false };
  }

  return { kind: 'unknown', usable: false, useBearer: false };
}

function dbConfig(env = process.env) {
  const url = String(env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const { key, source } = resolveServerKey(env);
  const cls = classifyServerKey(key);
  return { url, key, source, cls };
}

/**
 * DB 를 호출할 준비가 됐는가 (URL 있음 + 사용 가능한 서버 키).
 * @param {NodeJS.ProcessEnv} [env]
 */
export function haveDb(env = process.env) {
  const { url, cls } = dbConfig(env);
  return Boolean(url && cls.usable);
}

/**
 * @param {string} path  예: 'facilities?sido=eq.서울&limit=20'
 * @param {object} [opt]   { method, body, prefer, headers }
 * @param {object} [deps]  { env, fetchImpl, timeoutMs }  (테스트/진단 주입용)
 * @returns {Promise<{data:any, count:number|null}>}
 */
export async function sb(path, opt = {}, deps = {}) {
  const env = deps.env || process.env;
  const doFetch = deps.fetchImpl || fetch;
  const { url, key, cls } = dbConfig(env);

  if (!url) throw new Error('Supabase 미설정: SUPABASE_URL 없음');
  if (!cls.usable) {
    // 키 원문·일부·길이 노출 금지 — 분류(kind)만.
    throw new Error(`Supabase 서버 키 사용 불가 (kind=${cls.kind}). SUPABASE_SECRET_KEY 또는 legacy service_role JWT 필요`);
  }

  const { method = 'GET', body, prefer, headers = {} } = opt;
  const h = {
    apikey: key,
    'Content-Type': 'application/json',
    ...(cls.useBearer ? { Authorization: `Bearer ${key}` } : {}),
    ...(prefer ? { Prefer: prefer } : {}),
    ...headers,
  };

  let ctrl = null;
  let timer = null;
  if (deps.timeoutMs) {
    ctrl = new AbortController();
    timer = setTimeout(() => ctrl.abort(), deps.timeoutMs);
  }

  let res;
  try {
    res = await doFetch(`${url}/rest/v1/${path}`, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
      ...(ctrl ? { signal: ctrl.signal } : {}),
    });
  } finally {
    if (timer) clearTimeout(timer);
  }

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    throw new Error(`Supabase ${res.status} ${path} :: ${String(text).slice(0, 500)}`);
  }

  // Prefer: count=exact 이면 Content-Range: 0-19/1234 형태
  let count = null;
  const cr = res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-range') : null;
  if (cr && cr.includes('/')) {
    const n = Number(cr.split('/')[1]);
    if (!Number.isNaN(n)) count = n;
  }
  return { data, count };
}
