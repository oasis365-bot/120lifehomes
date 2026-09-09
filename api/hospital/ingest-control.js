// =====================================================================
// ⚠️ 임시 파일 (1B-3B 전용) — 시험 종료 후 main 병합 전 반드시 삭제.
//    함께 제거: Vercel Preview 환경변수  HOSPITAL_INGEST_CONTROL
// =====================================================================
// GET  /api/hospital/ingest-control
//   Vercel(SSO) 로그인 사용자가 Preview 브라우저에서 1B-3B 시험 적재를
//   단계별로 수행하는 임시 운영자 화면.
//     ① 사전점검 → ② dry-run(3) → ③ 최초 적재(3) → ④ 멱등성 재실행
//
// 안전장치:
//   · VERCEL_ENV=production                → 항상 404
//   · HOSPITAL_INGEST_CONTROL !== '1'      → 404 (사용자가 아직 미설정 → 배포해도 비활성)
//   · 요청 Host ≠ 정확한 branch alias      → 403 (정확 일치, includes/endsWith 아님)
//   · GET 은 읽기 전용 (DB write 0, HIRA 0). 실제 동작은 POST 만.
//   · limit 은 코드에서 3 고정. dryRun·limit 을 query 로 바꿀 수 없음 (req.query 미사용).
//   · SUPABASE_URL 은 lib/hira/persist.js 의 verifyPreviewDbUrl 로 정확 검증.
//   · CSRF: GET 이 CRON_SECRET-HMAC 토큰(5분) 발급 →
//           __Host- 쿠키(Secure/HttpOnly/SameSite=Strict) + form hidden 이중제출,
//           POST 는 timingSafeEqual + 서명·만료 검증, 처리 후 쿠키 만료.
//   · POST 는 Origin 이 정확한 branch alias 인지 검증.
//   · ③ 은 최근 5분 내 dry-run 성공(__Host-ic_dr 서명 쿠키) + "PREVIEW-3" 입력 필요.
//   · ④ 는 HOSPITAL=3 + "PREVIEW-3" 입력 필요.
//   · 내부 실행은 기존 /api/hospital/ingest 핸들러를 그대로 호출(우회 저장 로직 없음).
//     CRON_SECRET 은 그 내부 호출 인증에만 사용.
//   · 응답/화면/로그에 토큰·키·CRON_SECRET·ykiho·raw·DB URL·env 값 없음. console 미사용.
//   · no-store / noindex / X-Frame-Options DENY / frame-ancestors 'none' / 엄격 CSP.
//   · SSO(Vercel Authentication) 활성 여부는 코드가 검증 불가 —
//     화면에 명시하고 다른 신호로 추측하지 않는다.
// =====================================================================
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { verifyPreviewDbUrl, assertPreviewDb } from '../../lib/hira/persist.js';
import { sb as realSb } from '../../lib/db.js';
import { createHandler as createIngestHandler } from './ingest.js';

export const config = { maxDuration: 60 };

// ── 상수 (전부 코드 고정 — query 로 변경 불가) ──
export const BRANCH_ALIAS_HOST =
  '120lifehomes-git-feature-hospital-hira-adapter-120lifehomes.vercel.app';
export const SELF_PATH = '/api/hospital/ingest-control';
export const REQUIRED_LIMIT = 3;
export const CONFIRM_PHRASE = 'PREVIEW-3';
export const CSRF_TTL_MS = 5 * 60 * 1000;
const DR_TTL_MS = 5 * 60 * 1000;
const FLASH_TTL_MS = 60 * 1000;
const STEPS = ['precheck', 'dryrun', 'ingest', 'idempotency'];

const C_CSRF = '__Host-ic_csrf';
const C_DR = '__Host-ic_dr';
const C_FLASH = '__Host-ic_flash';

// ── HMAC 토큰 (키 원문은 어디에도 노출 안 함) ──
const hmac = (secret, msg) => createHmac('sha256', String(secret)).update(String(msg)).digest('hex');

function eqHex(aHex, bHex) {
  const A = String(aHex || '');
  const B = String(bHex || '');
  // 엄격 hex — Buffer.from(...,'hex') 는 잘못된 문자를 조용히 잘라내므로 사전 검증
  if (!A || A.length % 2 || A.length !== B.length) return false;
  if (!/^[0-9a-fA-F]+$/.test(A) || !/^[0-9a-fA-F]+$/.test(B)) return false;
  const a = Buffer.from(A, 'hex');
  const b = Buffer.from(B, 'hex');
  if (a.length === 0 || a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch { return false; }
}
function eqStr(a, b) {
  const A = Buffer.from(String(a || ''), 'utf8');
  const B = Buffer.from(String(b || ''), 'utf8');
  if (A.length === 0 || A.length !== B.length) return false;
  try { return timingSafeEqual(A, B); } catch { return false; }
}

export function mintToken(secret, kind, nowMs = Date.now()) {
  const nonce = randomBytes(9).toString('hex');
  return `${nowMs}.${nonce}.${hmac(secret, `${kind}:${nowMs}:${nonce}`)}`;
}
export function verifyToken(secret, kind, token, nowMs = Date.now(), ttl = CSRF_TTL_MS) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return false;
  const [tsStr, nonce, sig] = parts;
  const ts = Number(tsStr);
  if (!Number.isFinite(ts)) return false;
  if (nowMs - ts > ttl) return false;      // 만료
  if (ts - nowMs > 60_000) return false;    // 미래 발급(시계 오차 허용 1분)
  return eqHex(sig, hmac(secret, `${kind}:${ts}:${nonce}`));
}

function packFlash(secret, obj) {
  const p = Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  return `${p}.${hmac(secret, `flash:${p}`)}`;
}
function unpackFlash(secret, val) {
  const [p, sig] = String(val || '').split('.');
  if (!p || !sig || !eqHex(sig, hmac(secret, `flash:${p}`))) return null;
  try {
    const o = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    if (o && typeof o.t === 'number' && Date.now() - o.t <= FLASH_TTL_MS) return o;
  } catch { /* noop */ }
  return null;
}

// ── 쿠키 ──
function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i < 0) return;
    out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
const setCookie = (name, value, maxAge) =>
  `${name}=${encodeURIComponent(value)}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
const clearCookie = (name) => setCookie(name, '', 0);

// ── Origin 헤더를 new URL() 로 파싱해 구성요소별 boolean/분류값만 산출 ──
// 원본 Origin 문자열·전체 URL 은 절대 반환하지 않는다. 게이트에는 쓰지 않는다(진단 전용).
export function originUrlDiagnostics(originRaw, expectedHost = BRANCH_ALIAS_HOST) {
  const raw = typeof originRaw === 'string' ? originRaw : '';
  const out = {
    origin_is_literal_null: raw === 'null',
    origin_parseable: false,
    origin_protocol_https: false,
    origin_hostname_exact: false,
    origin_port_empty: false,
    origin_username_empty: false,
    origin_password_empty: false,
    origin_path_root_or_empty: false,
    origin_query_empty: false,
    origin_hash_empty: false,
    origin_matches_https_host_after_safe_url_normalization: false,
  };
  if (!raw || out.origin_is_literal_null) return out;

  let u;
  try { u = new URL(raw); } catch { return out; }
  out.origin_parseable = true;
  out.origin_protocol_https = u.protocol === 'https:';
  out.origin_hostname_exact = u.hostname === expectedHost;
  out.origin_port_empty = u.port === '';
  out.origin_username_empty = u.username === '';
  out.origin_password_empty = u.password === '';
  out.origin_path_root_or_empty = u.pathname === '' || u.pathname === '/';
  out.origin_query_empty = u.search === '';
  out.origin_hash_empty = u.hash === '';
  out.origin_matches_https_host_after_safe_url_normalization =
    out.origin_protocol_https && out.origin_hostname_exact && out.origin_port_empty &&
    out.origin_username_empty && out.origin_password_empty && out.origin_path_root_or_empty &&
    out.origin_query_empty && out.origin_hash_empty;
  return out;
}

// ── same-origin 판정 진단 (boolean 만 — 원본 Host/Origin/Referer 값은 절대 반환하지 않음) ──
// forbidden_host / forbidden_origin 오류에만 첨부. 정상 응답에는 넣지 않는다.
export function originDiagnostics(req) {
  const EXPECT_ORIGIN = `https://${BRANCH_ALIAS_HOST}`;
  const h = (req && req.headers) || {};
  const g = (k) => (typeof h[k] === 'string' ? h[k] : '');
  const host = g('host');
  const fwdHost = g('x-forwarded-host');
  const origin = g('origin');
  const referer = g('referer');
  const secFetchSite = g('sec-fetch-site');
  const method = String((req && req.method) || '').toUpperCase();

  let refererOrigin = null;
  if (referer) {
    try { refererOrigin = new URL(referer).origin; } catch { refererOrigin = null; }
  }

  return {
    host_present: host.length > 0,
    host_exact_match: host === BRANCH_ALIAS_HOST,
    forwarded_host_present: fwdHost.length > 0,
    forwarded_host_exact_match: fwdHost === BRANCH_ALIAS_HOST,
    origin_present: origin.length > 0,
    origin_exact_match: origin === EXPECT_ORIGIN,
    referer_present: referer.length > 0,
    referer_exact_origin: refererOrigin === EXPECT_ORIGIN,
    sec_fetch_site_same_origin: secFetchSite === 'same-origin',
    method_is_post: method === 'POST',
    // Origin URL 구성요소 분해 (진단 전용, 게이트 미반영)
    ...originUrlDiagnostics(origin),
  };
}

// ── HTML ──
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function securityHeaders(res, nonce) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // ⚠️ 'no-referrer' 금지 — Fetch 표준상 non-CORS 이고 GET/HEAD 아닌 요청(= 이 화면의
  //    form POST)의 Origin 헤더를 null 로 만든다("Append a request `Origin` header" 알고리즘
  //    referrer policy switch: "no-referrer" → serializedOrigin = null). 그러면
  //    같은 출처 제출인데도 origin_exact_match=false 로 forbidden_origin 이 뜬다.
  //    'same-origin' 은 같은 출처 요청에만 referrer 를 붙이고 Origin 은 정상 전송한다.
  res.setHeader('Referrer-Policy', 'same-origin');
  // ⚠️ CSP 에 sandbox 지시어 금지 — 문서를 opaque origin 으로 만들어 위와 같은 결과.
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; ` +
    `img-src 'none'; connect-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'`
  );
}

// ── DB 상태 읽기 (전부 GET — write 0) ──
export async function readPreviewState({ sb, env }) {
  const out = {
    destOk: verifyPreviewDbUrl(env.SUPABASE_URL).ok,
    guardOk: false,
    guardReason: 'unknown',
    schemaOk: false,
    persistEnabled: env.HOSPITAL_INGEST_PERSIST === '1',
    controlEnabled: env.HOSPITAL_INGEST_CONTROL === '1',
    hospitalModule: null,
    ltcCount: null,
    hospitalCount: null,
  };

  let guard;
  try { guard = await assertPreviewDb({ sb, env }); }
  catch { guard = { ok: false, reason: 'guard_error' }; }
  out.guardOk = guard.ok === true;
  out.guardReason = guard.reason || (guard.ok ? 'ok' : 'unknown');

  if (out.destOk) {
    try {
      const f = (await sb('feature_flags?key=eq.hospital_module&select=enabled&limit=1')).data?.[0];
      out.hospitalModule = f ? f.enabled === true : null;
    } catch { out.hospitalModule = null; }
    try {
      const r = await sb('facilities?domain=eq.LTC&select=id&limit=1', { prefer: 'count=exact' });
      out.ltcCount = r.count != null ? r.count : (Array.isArray(r.data) ? r.data.length : null);
    } catch { out.ltcCount = null; }
    try {
      const r = await sb('facilities?domain=eq.HOSPITAL&select=id&limit=1', { prefer: 'count=exact' });
      out.hospitalCount = r.count != null ? r.count : (Array.isArray(r.data) ? r.data.length : null);
    } catch { out.hospitalCount = null; }
    try {
      await sb('facility_sources?select=id&limit=1');
      await sb('hospital_profiles?select=facility_id&limit=1');
      await sb('ingestion_runs?select=id&limit=1');
      out.schemaOk = true;
    } catch { out.schemaOk = false; }
  }
  return out;
}

// ── 단계 가용성 (DB 상태만으로 판정 — 매 GET 재계산) ──
export function decideAvailability(state) {
  const s = state || {};
  const clean =
    s.destOk === true &&
    s.guardOk === true &&
    s.schemaOk === true &&
    s.persistEnabled === true &&
    s.hospitalModule === false &&
    s.ltcCount === 0;
  const countKnown = typeof s.hospitalCount === 'number';
  const overfilled = countKnown && s.hospitalCount > 3;
  const hardBlock = !clean || overfilled || !countKnown; // 개수 미상 → fail-closed
  return {
    clean,
    overfilled,
    hardBlock,
    precheck: true, // 읽기 전용 — 항상 가능
    dryrun: !hardBlock && s.hospitalCount === 0,
    ingest: !hardBlock && s.hospitalCount === 0,      // + dry-run 쿠키 + confirm 은 POST 에서
    idempotency: !hardBlock && s.hospitalCount === 3, // + confirm 은 POST 에서
  };
}

// ── 내부 실행: 기존 ingest 핸들러를 그대로 호출 (CRON_SECRET = 내부 인증에만) ──
// limit 은 여기서 3 으로 고정 — 외부 query 는 절대 반영되지 않는다.
// ② dry-run = readiness (목록만). ③ = full collect 1회 → 그대로 persist.
export function internalIngestQuery(dryRun) {
  return dryRun
    ? { limit: String(REQUIRED_LIMIT), readiness: '1' }
    : { dryRun: 'false', limit: String(REQUIRED_LIMIT) };
}

async function defaultRunIngest({ env, dryRun }) {
  const handler = createIngestHandler({
    env,
    sbImpl: (path, opt) => realSb(path, opt, { env }),
  });
  const req = {
    headers: { authorization: `Bearer ${env.CRON_SECRET || ''}` },
    query: internalIngestQuery(dryRun),
  };
  const cap = { status: 200, body: null };
  await handler(req, {
    status(c) { cap.status = c; return this; },
    json(b) { cap.body = b; return this; },
    setHeader() { /* 무시 */ },
  });
  return cap;
}

const intOrNull = (v) => (Number.isFinite(v) ? v : null);

// stats 에서 정수 필드만 화이트리스트로 추출 (ykiho·raw·문자열 상세 제외)
function safeStats(stats) {
  const s = stats && typeof stats === 'object' ? stats : {};
  const pick = ['new', 'updated', 'unchanged', 'partial', 'failed',
    'evalNew', 'evalUpdated', 'evalMissing', 'revisions'];
  const out = {};
  for (const k of pick) out[k] = Number.isFinite(s[k]) ? s[k] : 0;
  return out;
}

function renderPage({ nonce, csrf, state, avail, drReady, flash }) {
  const row = (label, val, good) =>
    `<tr><th>${esc(label)}</th><td class="${good === true ? 'ok' : good === false ? 'bad' : ''}">${esc(val)}</td></tr>`;
  const yn = (v) => (v === true ? '예' : v === false ? '아니오' : '알 수 없음');

  const stateRows = [
    row('DB 목적지 검증 (정확 일치)', state.destOk ? '통과' : 'wrong_preview_db', state.destOk),
    row('안전 게이트 (assertPreviewDb)', state.guardReason, state.guardOk),
    row('001 스키마', yn(state.schemaOk), state.schemaOk),
    row('hospital_module', yn(state.hospitalModule === false ? false : state.hospitalModule), state.hospitalModule === false),
    row('HOSPITAL_INGEST_PERSIST=1', yn(state.persistEnabled), state.persistEnabled),
    row('facilities LTC', state.ltcCount == null ? '알 수 없음' : String(state.ltcCount), state.ltcCount === 0),
    row('facilities HOSPITAL', state.hospitalCount == null ? '알 수 없음' : String(state.hospitalCount),
      state.hospitalCount === 0 || state.hospitalCount === 3),
  ].join('');

  const stepForm = (step, title, desc, enabled, opts = {}) => {
    const { confirm = false, gated = false, note = '' } = opts;
    return `
    <form method="POST" action="${SELF_PATH}"${confirm ? ` data-confirm="${CONFIRM_PHRASE}"` : ''}${gated ? ' data-gated="1"' : ''}>
      <h3>${esc(title)}</h3>
      <p class="desc">${esc(desc)}</p>
      <input type="hidden" name="csrf" value="${esc(csrf)}">
      <input type="hidden" name="step" value="${esc(step)}">
      ${confirm ? `<label>실행하려면 <code>${CONFIRM_PHRASE}</code> 입력:
        <input type="text" name="confirm" autocomplete="off" spellcheck="false"></label>` : ''}
      <button type="submit"${enabled && !confirm ? '' : ' disabled'}>${esc(title)}</button>
      ${note ? `<p class="note">${esc(note)}</p>` : ''}
    </form>`;
  };

  let flashHtml = '';
  if (flash) {
    const stopNote = flash.ok
      ? ''
      : '<p class="note bad">실패/차단되었습니다. 버튼을 다시 누르지 말고, 위 <code>코드</code> 와 숫자를 그대로 보고하세요.</p>';
    flashHtml = `<section class="flash ${flash.ok ? 'ok' : 'bad'}">
      <h2>직전 실행 결과 — ${esc(flash.step)} · ${flash.ok ? '성공' : '실패/차단'}</h2>
      <p>코드: <code>${esc(flash.code || '')}</code></p>
      ${stopNote}
      <pre>${esc(JSON.stringify(flash.detail || {}, null, 2))}</pre>
    </section>`;
  }

  const overfillNote = avail.overfilled
    ? '<p class="note bad">HOSPITAL 행이 3을 초과합니다 — 모든 실행이 차단되었습니다.</p>' : '';
  const partialNote = (!avail.overfilled && typeof state.hospitalCount === 'number'
    && state.hospitalCount !== 0 && state.hospitalCount !== 3)
    ? `<p class="note bad">HOSPITAL=${state.hospitalCount} (0도 3도 아님) — 비정상 상태. 추가 실행이 차단되었습니다.</p>` : '';

  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>1B-3B 임시 시험 적재 · Preview 전용</title>
<style nonce="${nonce}">
  body{font:14px/1.6 system-ui,-apple-system,'Segoe UI',sans-serif;max-width:720px;margin:0 auto;padding:20px;color:#1c1c1c;background:#fafafa}
  h1{font-size:18px} h2{font-size:15px} h3{font-size:14px;margin:.2em 0}
  .warn{background:#fff4e5;border:1px solid #e8b878;border-radius:8px;padding:12px 14px;margin:10px 0}
  .warn strong{color:#a15c00}
  table{border-collapse:collapse;width:100%;margin:10px 0;background:#fff}
  th,td{border:1px solid #ddd;padding:6px 10px;text-align:left;font-size:13px}
  th{background:#f2f2f2;width:52%;font-weight:600}
  td.ok{color:#0a7d2c;font-weight:600} td.bad{color:#c0261c;font-weight:600}
  form{border:1px solid #ddd;border-radius:8px;padding:12px 14px;margin:10px 0;background:#fff}
  .desc{color:#555;font-size:12.5px;margin:.2em 0 .6em}
  button{font:inherit;padding:7px 16px;border-radius:6px;border:1px solid #888;background:#f0f0f0;cursor:pointer}
  button:disabled{opacity:.45;cursor:not-allowed}
  input[type=text]{font:inherit;padding:5px 8px;border:1px solid #999;border-radius:4px;margin-left:6px}
  code{background:#eee;padding:1px 5px;border-radius:3px;font-size:12px}
  pre{background:#f4f4f4;border:1px solid #ddd;border-radius:6px;padding:10px;overflow:auto;font-size:12px}
  .note{font-size:12px;color:#777;margin:.4em 0 0} .note.bad{color:#c0261c}
  .flash{border-radius:8px;padding:10px 14px;margin:12px 0}
  .flash.ok{background:#eef8ee;border:1px solid #9ccf9c} .flash.bad{background:#fdeeed;border:1px solid #e0a19c}
</style></head><body>
<h1>요양병원 1B-3B — 임시 시험 적재 화면 (Preview 전용)</h1>

<div class="warn">
  <strong>⚠️ 이 화면은 Vercel Authentication(SSO)이 켜진 상태에서만 사용하세요.</strong><br>
  서버 코드는 SSO 활성 여부를 검증할 수 없습니다 — 이 화면이 열렸다는 사실이 SSO 통과를 의미하지 않습니다.
  로그인 보호가 꺼져 있다고 의심되면 즉시 닫고 Vercel 설정을 확인하세요.
</div>
<div class="warn">
  임시 파일입니다. 시험 종료 후 <code>api/hospital/ingest-control.js</code> 와
  <code>HOSPITAL_INGEST_CONTROL</code> 환경변수를 반드시 제거하세요.<br>
  적재 수량은 서버에서 <strong>정확히 3</strong>으로 고정됩니다. URL 로 <code>limit</code>·<code>dryRun</code> 을 바꿀 수 없습니다.
</div>

${flashHtml}

<h2>현재 Preview DB 상태 (매 새로고침 시 재조회)</h2>
<table>${stateRows}</table>
${overfillNote}${partialNote}

${stepForm('precheck', '① 사전점검', '위 상태를 다시 읽어 결과를 기록합니다. DB write·HIRA 호출 없음.', true)}

${stepForm('dryrun', '② Readiness Dry-run 3건',
  'HIRA 목록(getHospBasisList)만 호출해 요양병원 3곳을 확보하고 기본 정규화·ykiho 중복·필수필드·Preview DB 안전 게이트를 확인합니다. 상세 6종·평가 API 는 호출하지 않습니다. DB write 0. ① 조건이 모두 충족돼야 활성화됩니다.',
  avail.dryrun)}

${stepForm('ingest', '③ 최초 적재 3건',
  'HIRA 목록+상세+평가를 1회 전체 수집한 뒤, 재수집 없이 그 결과를 Preview DB 에 그대로 적재합니다. 기본시설이 정확히 3건이 아니면 적재를 시작하지 않습니다. 최근 5분 내 ② Readiness 성공 + HOSPITAL=0 + 확인문구가 필요합니다.',
  avail.ingest && drReady,
  {
    confirm: avail.ingest && drReady,
    gated: avail.ingest && drReady,
    note: !avail.ingest ? '차단: ① 조건 미충족 또는 HOSPITAL≠0'
      : !drReady ? '차단: 최근 5분 내 ② Readiness Dry-run 성공 기록이 없습니다. ② 를 먼저 실행하세요.' : '',
  })}

${stepForm('idempotency', '④ 멱등성 재실행',
  'HOSPITAL=3 일 때만, 동일 적재를 1회 재실행해 unchanged=3 을 확인합니다.',
  avail.idempotency,
  {
    confirm: avail.idempotency,
    gated: avail.idempotency,
    note: !avail.idempotency ? '차단: HOSPITAL 이 정확히 3이 아닙니다.' : '',
  })}

<script nonce="${nonce}">
(function(){
  var gatedForms = document.querySelectorAll('form[data-gated="1"][data-confirm]');
  Array.prototype.forEach.call(gatedForms, function(f){
    var inp = f.querySelector('input[name="confirm"]');
    var btn = f.querySelector('button[type="submit"]');
    if(!inp||!btn) return;
    var want = f.getAttribute('data-confirm');
    function sync(){ btn.disabled = (inp.value !== want); }
    inp.addEventListener('input', sync); sync();
  });
  Array.prototype.forEach.call(document.querySelectorAll('form'), function(f){
    f.addEventListener('submit', function(){
      Array.prototype.forEach.call(document.querySelectorAll('button[type="submit"]'), function(b){ b.disabled = true; });
    });
  });
})();
</script>
</body></html>`;
}

// ── 핸들러 ──
export function createHandler(deps = {}) {
  const env = deps.env ?? process.env;
  const sb = deps.sb ?? ((path, opt) => realSb(path, opt, { env }));
  const runIngest = deps.runIngest ?? ((o) => defaultRunIngest({ ...o, env }));
  const now = deps.now ?? (() => Date.now());

  return async function handler(req, res) {
    const nonce = randomBytes(16).toString('base64url');

    // 1) production 은 무조건 404
    if (env.VERCEL_ENV === 'production') { res.status(404).json({ error: 'not_found' }); return; }
    // 2) 활성화 스위치 없으면 404
    if (env.HOSPITAL_INGEST_CONTROL !== '1') { res.status(404).json({ error: 'not_found' }); return; }
    // 3) 내부 인증 키가 없으면 CSRF 도 불가 → 중단
    const secret = env.CRON_SECRET || '';
    if (!secret) { res.status(503).json({ error: 'control_unavailable' }); return; }

    // 4) Host 정확 일치 (부분 비교 금지). forbidden_host 는 forbidden_origin 과 별도 코드.
    //    ※ Vercel 프록시가 host 를 내부 배포값으로 바꾸는지 여부는 아직 미확인 →
    //      x-forwarded-host 는 게이트에 쓰지 않고 진단(diagnostics)으로만 노출한다.
    const diag = originDiagnostics(req);
    if (!diag.host_exact_match) {
      securityHeaders(res, nonce);
      res.status(403).json({ error: 'forbidden_host', diagnostics: diag });
      return;
    }

    const method = (req.method || 'GET').toUpperCase();
    const cookies = parseCookies(req.headers?.cookie);
    const tNow = now();

    if (method === 'GET') {
      securityHeaders(res, nonce);
      const state = await readPreviewState({ sb, env });
      const avail = decideAvailability(state);
      const drReady = verifyToken(secret, 'dryrun', cookies[C_DR], tNow, DR_TTL_MS);
      const flash = unpackFlash(secret, cookies[C_FLASH]);
      const csrf = mintToken(secret, 'csrf', tNow);
      res.setHeader('Set-Cookie', [
        setCookie(C_CSRF, csrf, Math.floor(CSRF_TTL_MS / 1000)),
        clearCookie(C_FLASH), // flash 는 1회 표시 후 소거
      ]);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(renderPage({ nonce, csrf, state, avail, drReady, flash }));
      return;
    }

    if (method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

    // ── POST ──
    securityHeaders(res, nonce);

    // same-origin POST 만 허용 (완화 금지):
    //   · Origin 헤더가 존재하고  ===  https://<branch alias>
    //   · Sec-Fetch-Site === 'same-origin'
    //   Origin 누락/null 은 거부. Referer 만으로 대체하지 않는다.
    //   (SSO 활성 여부는 애플리케이션이 검증하지 않는다 — 위 두 조건은 same-origin 판정일 뿐.)
    if (!(diag.origin_present && diag.origin_exact_match && diag.sec_fetch_site_same_origin)) {
      res.status(403).json({ error: 'forbidden_origin', diagnostics: diag });
      return;
    }

    const body = await readFormBody(req);
    const step = String(body.step || '');
    if (!STEPS.includes(step)) { res.status(400).json({ error: 'bad_step' }); return; }

    // CSRF: 이중제출 + 서명·만료
    const cookieCsrf = cookies[C_CSRF] || '';
    const formCsrf = String(body.csrf || '');
    const csrfOk = eqStr(formCsrf, cookieCsrf) && verifyToken(secret, 'csrf', cookieCsrf, tNow, CSRF_TTL_MS);
    if (!csrfOk) {
      res.setHeader('Set-Cookie', [clearCookie(C_CSRF)]);
      res.status(403).json({ error: 'csrf' });
      return;
    }

    // 매 POST 마다 상태 재조회
    const state = await readPreviewState({ sb, env });
    const avail = decideAvailability(state);
    const confirmOk = eqStr(String(body.confirm || ''), CONFIRM_PHRASE);
    const drReady = verifyToken(secret, 'dryrun', cookies[C_DR], tNow, DR_TTL_MS);

    // 처리 후 항상 CSRF 쿠키 만료
    const outCookies = [clearCookie(C_CSRF)];
    const done = (flashObj, extraCookies = []) => {
      res.setHeader('Set-Cookie', [...outCookies, ...extraCookies, packFlashCookie(secret, flashObj)]);
      res.setHeader('Location', SELF_PATH);
      res.status(302).end();
    };
    const blocked = (code, detail = {}) =>
      done({ t: tNow, step, ok: false, code, detail });

    // ── 단계별 게이트 + 실행 ──
    if (step === 'precheck') {
      done({
        t: tNow, step, ok: avail.clean && !avail.overfilled,
        code: avail.overfilled ? 'hospital_over_3' : avail.clean ? 'ok' : `not_clean:${state.guardReason}`,
        detail: publicState(state),
      });
      return;
    }

    if (avail.hardBlock) { blocked(`hard_block:${state.guardReason}`, publicState(state)); return; }

    if (step === 'dryrun') {
      if (!avail.dryrun) { blocked('state_not_clean', publicState(state)); return; }
      let r;
      try { r = await runIngest({ dryRun: true }); }
      catch { blocked('dryrun_error'); return; }
      if (r.status !== 200 || !r.body || r.body.ok !== true) {
        const b = (r && r.body) || {};
        const ec = typeof b.error === 'string' ? b.error : null;
        blocked(ec || 'dryrun_failed', {
          http: r.status,
          errorCode: ec,
          reason: typeof b.reason === 'string' ? b.reason : null,
          attempts: intOrNull(b.attempts),
        });
        return;
      }
      const st = r.body.stats || {};
      const normalizedN = Number.isFinite(st.normalized) ? st.normalized : null;
      const dedupedN = Number.isFinite(st.deduped) ? st.deduped : null;
      const detail = {
        http: r.status,
        mode: typeof r.body.mode === 'string' ? r.body.mode : null, // 'readiness'
        dbWrites: r.body.dbWrites === 0 ? 0 : r.body.dbWrites,
        deduped: dedupedN,
        normalized: normalizedN,
        listApiCalls: Number.isFinite(st.apiCalls) ? st.apiCalls : null, // readiness 면 목록 호출 수
        listRetries: Number.isFinite(st.listRetries) ? st.listRetries : null,
        warnings: Array.isArray(r.body.warnings) ? r.body.warnings.length : 0,
        failures: Array.isArray(r.body.failures) ? r.body.failures.length : 0,
      };
      // readiness 도 "정확히 REQUIRED_LIMIT 건 확보" 여야 진행 토큰(ic_dr)을 준다.
      if (normalizedN !== REQUIRED_LIMIT) {
        blocked('readiness_incomplete', detail);
        return;
      }
      done(
        { t: tNow, step, ok: true, code: 'ok', detail },
        [setCookie(C_DR, mintToken(secret, 'dryrun', tNow), Math.floor(DR_TTL_MS / 1000))]
      );
      return;
    }

    if (step === 'ingest') {
      if (!avail.ingest || state.hospitalCount !== 0) { blocked('hospital_not_zero', publicState(state)); return; }
      if (!drReady) { blocked('need_dryrun'); return; }
      if (!confirmOk) { blocked('need_confirm'); return; }

      let r;
      try { r = await runIngest({ dryRun: false }); }
      catch { blocked('ingest_error'); return; }

      // 실행 후 재조회 (자동 재시도·자동 수정 없음 — 결과만 기록)
      const after = await readPreviewState({ sb, env });
      const b = (r && r.body) || {};
      const persisted = safeStats(b.persisted);
      const errCode = typeof b.error === 'string' ? b.error : null;
      // 첫 적재는 new=3 이고 실제 HOSPITAL 행이 정확히 3 일 때만 성공.
      const okShape =
        r.status === 200 && b.ok === true &&
        persisted.new === 3 && after.hospitalCount === 3;

      done(
        {
          t: tNow, step, ok: okShape,
          code: okShape ? 'ok'
            : errCode ? errCode
              : r.status !== 200 ? `http_${r.status}`
                : after.hospitalCount !== 3 ? 'unexpected_hospital_count'
                  : 'unexpected_persist_stats',
          detail: {
            http: r.status,
            errorCode: errCode,
            reason: typeof b.reason === 'string' ? b.reason : null,
            attempts: intOrNull(b.attempts),
            persisted,
            collectedCount: intOrNull(b.collectedCount),
            normalizedCount: intOrNull(b.normalizedCount),
            persistInputCount: intOrNull(b.persistInputCount),
            listRetries: intOrNull(b.listRetries),
            expected: intOrNull(b.expected),
            writeSum: intOrNull(b.writeSum),
            runId: Number.isFinite(b.runId) ? b.runId : null,
            persistStatus: typeof b.persistStatus === 'string' ? b.persistStatus : null,
            failures: Array.isArray(b.failures) ? b.failures.length : 0,
            hospitalCountAfter: after.hospitalCount,
          },
        },
        [clearCookie(C_DR)] // dry-run 토큰은 1회용
      );
      return;
    }

    if (step === 'idempotency') {
      if (!avail.idempotency || state.hospitalCount !== 3) { blocked('hospital_not_three', publicState(state)); return; }
      if (!confirmOk) { blocked('need_confirm'); return; }

      const before = await countTables(sb);
      let r;
      try { r = await runIngest({ dryRun: false }); }
      catch { blocked('ingest_error'); return; }
      const after = await countTables(sb);
      const b = (r && r.body) || {};
      const persisted = safeStats(b.persisted);
      const errCode = typeof b.error === 'string' ? b.error : null;

      const grewOnlyRuns =
        after.hospital === before.hospital &&
        after.profiles === before.profiles &&
        after.sources === before.sources &&
        after.evaluations === before.evaluations &&
        after.revisions === before.revisions &&
        after.runs >= before.runs;

      const okShape =
        r.status === 200 && b.ok === true &&
        persisted.unchanged === 3 && persisted.new === 0 &&
        after.hospital === 3 && grewOnlyRuns;

      done({
        t: tNow, step, ok: okShape,
        code: okShape ? 'ok'
          : errCode ? errCode
            : r.status !== 200 ? `http_${r.status}`
              : !grewOnlyRuns ? 'unexpected_row_growth'
                : 'unexpected_persist_stats',
        detail: {
          http: r.status, errorCode: errCode, persisted,
          collectedCount: intOrNull(b.collectedCount),
          normalizedCount: intOrNull(b.normalizedCount),
          persistInputCount: intOrNull(b.persistInputCount),
          rows: after,
          rowDelta: {
            hospital: after.hospital - before.hospital,
            profiles: after.profiles - before.profiles,
            sources: after.sources - before.sources,
            evaluations: after.evaluations - before.evaluations,
            revisions: after.revisions - before.revisions,
            runs: after.runs - before.runs,
          },
        },
      }, [clearCookie(C_DR)]);
      return;
    }

    blocked('unhandled');
  };
}

function publicState(s) {
  return {
    destOk: s.destOk, guardOk: s.guardOk, guardReason: s.guardReason,
    schemaOk: s.schemaOk, persistEnabled: s.persistEnabled,
    hospitalModule: s.hospitalModule, ltcCount: s.ltcCount, hospitalCount: s.hospitalCount,
  };
}

function packFlashCookie(secret, obj) {
  return setCookie(C_FLASH, packFlash(secret, obj), Math.floor(FLASH_TTL_MS / 1000));
}

async function countTables(sb) {
  const one = async (path) => {
    try {
      const r = await sb(path, { prefer: 'count=exact' });
      return r.count != null ? r.count : (Array.isArray(r.data) ? r.data.length : null);
    } catch { return null; }
  };
  return {
    hospital: await one('facilities?domain=eq.HOSPITAL&select=id&limit=1'),
    profiles: await one('hospital_profiles?select=facility_id&limit=1'),
    sources: await one('facility_sources?select=id&limit=1'),
    evaluations: await one('facility_evaluations?select=id&limit=1'),
    revisions: await one('facility_revisions?select=id&limit=1'),
    runs: await one('ingestion_runs?select=id&limit=1'),
  };
}

async function readFormBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Object.fromEntries(new URLSearchParams(req.body));
  if (Buffer.isBuffer(req.body)) return Object.fromEntries(new URLSearchParams(req.body.toString('utf8')));
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    if (!chunks.length) return {};
    return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
  } catch { return {}; }
}

export default createHandler();
