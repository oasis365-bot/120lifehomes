// 요양원(LTC) 화면 격리 + 요양병원 지역 선택지(view=regions) + 상세정보 상태 표시
//  1) hospital_module ON 이면 기존 요양원 검색·홈 목록에 요양병원이 섞이던 문제
//  2) HIRA 원본 지역명('전남광주', '세종시', '수원장안구' …)과 화면 선택지가 달라 필터 결과가 0 이던 문제,
//     같은 공식 코드(360000)가 두 이름('전남광주'·'전라남도')으로 갈라져 나주시 7곳 중 1곳이 빠지던 문제
//  3) 상세정보 미수집·평가 자료 없음을 빈칸 숨김이 아니라 확정 문구로 구분
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createHandler as createHospitalList } from '../../api/hospital/facilities.js';
import { makeMockSb } from './mockSb.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => readFileSync(root + p, 'utf8');

function mkRes() {
  return {
    statusCode: null, body: null, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    setHeader(k, v) { this.headers[k] = v; },
  };
}

/* =====================================================================
 * A. 기존 요양원 API (api/facilities.js · api/facility.js)
 *    실제 핸들러 + 요양원·요양병원 예시 데이터를 가진 가짜 DB(PostgREST 흉내)
 * ===================================================================== */
process.env.SUPABASE_URL = 'https://db.example.test';
process.env.SUPABASE_SECRET_KEY = 'sb_secret_test_only';

// 요양병원이 더 최근 지정(established_at)이라, 섞이면 홈 "최근 지정된 기관" 맨 앞에 나온다.
const SAMPLE = [
  { id: '11111000001', name: '가람노인요양원', sido: '서울특별시', sigungu: '11110', sigungu_nm: '종로구', type_label: '노인요양시설(요양원)', eval_grade: 'A', established_at: '2020-01-01', domain: 'LTC' },
  { id: '11111000002', name: '나래노인요양원', sido: '서울특별시', sigungu: '11680', sigungu_nm: '강남구', type_label: '노인요양시설(요양원)', eval_grade: 'B', established_at: '2022-05-01', domain: 'LTC' },
  { id: '22222000003', name: '다솜주야간보호센터', sido: '부산광역시', sigungu: '26110', sigungu_nm: '중구', type_label: '주야간보호센터(데이케어)', eval_grade: null, established_at: '2021-03-01', domain: 'LTC' },
  { id: 'H-aaa', name: '가나요양병원', sido: '서울특별시', sigungu: null, sigungu_nm: '종로구', type_label: '요양병원', established_at: '2025-01-01', domain: 'HOSPITAL' },
  { id: 'H-bbb', name: '라마요양병원', sido: '부산광역시', sigungu: null, sigungu_nm: '중구', type_label: '요양병원', established_at: '2025-06-01', domain: 'HOSPITAL' },
];
const LTC_IDS = SAMPLE.filter((r) => r.domain === 'LTC').map((r) => r.id);
const db = makeMockSb({ facilities: SAMPLE });

let flagMode = 'fail'; // 'fail' | 'on' | 'off'
const seen = [];
globalThis.fetch = async (url, opt = {}) => {
  const u = String(url);
  seen.push(decodeURIComponent(u));
  const path = u.split('/rest/v1/')[1] || '';
  if (path.startsWith('feature_flags')) {
    if (flagMode === 'fail') return new Response('boom', { status: 500 });
    return new Response(JSON.stringify([{ key: 'hospital_module', enabled: flagMode === 'on' }]), { status: 200 });
  }
  const prefer = opt.headers && opt.headers.Prefer;
  const { data, count } = await db(path, { prefer });
  const headers = count == null ? {} : { 'content-range': `0-${Math.max(0, data.length - 1)}/${count}` };
  return new Response(JSON.stringify(data), { status: 200, headers });
};

const { default: ltcList } = await import('../../api/facilities.js');
const { default: ltcDetail } = await import('../../api/facility.js');
const { _resetFlagCache } = await import('../../lib/flags.js');

const lastFacilitiesUrl = () => [...seen].reverse().find((u) => u.includes('/rest/v1/facilities'));
async function callList(query) {
  _resetFlagCache();
  seen.length = 0;
  const res = mkRes();
  await ltcList({ query }, res);
  return { res, url: lastFacilitiesUrl(), ids: (res.body.items || []).map((r) => r.id) };
}
async function callDetail(id) {
  _resetFlagCache();
  seen.length = 0;
  const res = mkRes();
  await ltcDetail({ query: { id } }, res);
  return res;
}
// 화면이 실제로 보내는 요청(search.html·index.html·facility.html)
const SCREEN_QUERIES = {
  '검색 첫 화면': {},
  '검색 시도 필터': { sido: '서울특별시' },
  '검색 유형 필터': { type: '노인요양시설(요양원)' },
  '검색 기관명': { q: '요양' },
  '홈 최근 지정 3곳': { sort: 'new', size: '3' },
  '상세 주변 시설': { sido: '부산광역시', type: '주야간보호센터(데이케어)', size: '4' },
};

// 이 시험은 반드시 첫 번째(이 프로세스에서 flag 표를 한 번도 못 읽은 상태)여야 한다.
test('예시 데이터: flag 표를 못 읽은 새 서버(schemaReady=false)도 요양원만, 결과 동일', async () => {
  flagMode = 'fail';
  const { res, url, ids } = await callList({});
  assert.equal(res.statusCode, 200);
  assert.ok(url.includes('id=not.like.H-*'), url);
  assert.equal(url.includes('domain='), false, 'domain 컬럼 미참조(마이그레이션 전 호환)');
  assert.deepEqual(ids, ['11111000001', '11111000002', '22222000003']);
  assert.equal(res.body.total, 3);
});

test('예시 데이터: 검색·홈·주변 시설 — 스위치 OFF 와 ON 의 결과가 같고 요양병원 0', async () => {
  for (const [label, query] of Object.entries(SCREEN_QUERIES)) {
    flagMode = 'off';
    // eslint-disable-next-line no-await-in-loop
    const off = await callList(query);
    flagMode = 'on';
    // eslint-disable-next-line no-await-in-loop
    const on = await callList(query);
    assert.equal(off.res.statusCode, 200, label);
    assert.equal(on.res.statusCode, 200, label);
    assert.deepEqual(on.ids, off.ids, `${label}: ON/OFF 결과 다름`);
    assert.equal(on.res.body.total, off.res.body.total, `${label}: total 다름`);
    assert.ok(on.ids.length > 0, `${label}: 결과 0 (시험 데이터 확인)`);
    assert.equal(on.ids.some((id) => id.startsWith('H-')), false, `${label}: 요양병원 섞임`);
    assert.ok(on.url.includes('domain=eq.LTC') && off.url.includes('domain=eq.LTC'), label);
  }
});

test('예시 데이터: 홈 최근 지정 3곳 = 요양원 최신순 (더 최근인 요양병원이 끼지 않음)', async () => {
  for (const mode of ['off', 'on']) {
    flagMode = mode;
    // eslint-disable-next-line no-await-in-loop
    const { ids } = await callList({ sort: 'new', size: '3' });
    assert.deepEqual(ids, ['11111000002', '22222000003', '11111000001'], mode);
  }
});

test('예시 데이터: OFF 는 domain 파라미터를 무시, ON 은 HOSPITAL/ALL 을 명시할 때만 병원 포함', async () => {
  flagMode = 'off';
  for (const domain of ['HOSPITAL', 'ALL']) {
    // eslint-disable-next-line no-await-in-loop
    const { ids } = await callList({ domain });
    assert.deepEqual(ids, LTC_IDS, domain);
  }
  flagMode = 'on';
  assert.deepEqual((await callList({ domain: 'LTC' })).ids, LTC_IDS);
  assert.deepEqual((await callList({ domain: 'xyz' })).ids, LTC_IDS);
  assert.deepEqual((await callList({ domain: 'HOSPITAL' })).ids, ['H-aaa', 'H-bbb']);
  assert.equal((await callList({ domain: 'ALL' })).res.body.total, 5);
});

test('예시 데이터: 요양원 상세 — 요양원은 ON/OFF 모두 200, 요양병원 id 는 DB 조회 없이 404', async () => {
  for (const mode of ['on', 'off']) {
    flagMode = mode;
    // eslint-disable-next-line no-await-in-loop
    const ok = await callDetail('11111000002');
    assert.equal(ok.statusCode, 200, mode);
    assert.equal(ok.body.item.id, '11111000002');
    assert.equal(ok.body.item.name, '나래노인요양원');
    assert.ok(lastFacilitiesUrl().includes('domain=eq.LTC'));
    // eslint-disable-next-line no-await-in-loop
    const h = await callDetail('H-aaa');
    assert.equal(h.statusCode, 404, mode);
    assert.equal(seen.length, 0, `${mode}: H- id 로 DB 조회 발생`);
  }
});

test('정적: 요양원 화면(search.html·index.html)은 그대로 — domain 을 보내지 않아도 서버가 요양원만 준다', () => {
  for (const f of ['search.html', 'index.html']) {
    assert.equal(/domain=|hospital/i.test(read(f).replace(/<!--[^]*?-->/g, '')), false, f);
  }
});

/* =====================================================================
 * B. GET /api/hospital/facilities?view=regions — 원본 이름 보존 + 같은 공식 코드끼리 묶음
 * ===================================================================== */
const flagsOn = async () => ({ flags: { hospital_module: true }, schemaReady: true });
const flagsOff = async () => ({ flags: {}, schemaReady: true });
const HL = (sb, getFlags = flagsOn) => createHospitalList({ sb, getFlags });

function regionSeed() {
  const facilities = [];
  const facility_sources = [];
  let n = 0;
  // code: [sidoCd, sgguCd] — null 이면 원본 행 없음(코드 미확인)
  const add = (count, sido, sigungu_nm, code) => {
    for (let i = 0; i < count; i += 1) {
      n += 1;
      const id = `H-${String(n).padStart(5, '0')}`;
      facilities.push({ id, name: `병원${n}`, sido, sigungu_nm, domain: 'HOSPITAL' });
      if (code) facility_sources.push({ facility_id: id, source_system: 'hira_hospital_ingest', sido_cd: code[0], sggu_cd: code[1] });
    }
  };
  add(9, '전남광주', '광주동구', ['360000', '360100']);
  add(6, '전남광주', '나주시', ['360000', '360200']);
  add(1, '전라남도', '나주시', ['360000', '360200']); // 같은 공식 코드, 옛 표기
  add(4, '세종시', '세종시', ['410000', '410000']);
  add(3, '경기도', '수원장안구', ['310000', '310101']);
  add(1100, '서울특별시', '강남구', ['110000', '110001']); // 1000 행 넘는 페이지 분할 확인
  add(1, '코드없음도', '어느군', null);
  facilities.push({ id: '11111000006', name: '요양원', sido: '서울특별시', sigungu_nm: '종로구', domain: 'LTC' });
  return { facilities, facility_sources };
}
const RAW_SIDO = new Set(regionSeed().facilities.filter((f) => f.domain === 'HOSPITAL').map((f) => f.sido));

async function getRegions(sb) {
  const res = mkRes();
  await HL(sb)({ method: 'GET', query: { view: 'regions' } }, res);
  return res;
}

test('regions: flag OFF → 404, DB 조회 0', async () => {
  const sb = makeMockSb(regionSeed());
  const res = mkRes();
  await HL(sb, flagsOff)({ method: 'GET', query: { view: 'regions' } }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(sb.calls.length, 0);
});

test('regions: 잘못된 view → 400, DB 조회 0', async () => {
  const sb = makeMockSb(regionSeed());
  const res = mkRes();
  await HL(sb)({ method: 'GET', query: { view: 'all' } }, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'invalid_view' });
  assert.equal(sb.calls.length, 0);
});

test('regions: 같은 공식 코드(360000)는 한 선택지 — 이름은 원본에서 고르고(새 이름 없음), 원본 이름 모두 보존', async () => {
  const sb = makeMockSb(regionSeed());
  const res = await getRegions(sb);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  const by = Object.fromEntries(res.body.regions.map((r) => [r.sido, r]));
  assert.deepEqual(Object.keys(by).sort(), ['경기도', '서울특별시', '세종시', '전남광주', '코드없음도'].sort());
  for (const r of res.body.regions) {
    assert.ok(RAW_SIDO.has(r.sido), `선택지 이름 "${r.sido}" 가 원본에 없음`);
    for (const nm of r.names) assert.ok(RAW_SIDO.has(nm), nm);
  }
  // 360000: 가장 많이 쓰인 원본 이름이 선택지, 옛 표기도 names 에 그대로
  assert.deepEqual(by['전남광주'].names, ['전남광주', '전라남도']);
  assert.equal(by['전남광주'].count, 16);
  const naju = by['전남광주'].sigungu.find((s) => s.name === '나주시');
  assert.deepEqual(naju, { name: '나주시', names: ['나주시'], count: 7 });
  assert.equal(by['전남광주'].sigungu.find((s) => s.name === '광주동구').count, 9);
  // 그 밖은 1:1 — 이름 그대로
  assert.deepEqual(by['세종시'].names, ['세종시']);
  assert.deepEqual(by['경기도'].sigungu, [{ name: '수원장안구', names: ['수원장안구'], count: 3 }]);
  assert.equal(by['서울특별시'].count, 1100, '페이지 분할 누락');
  assert.equal(by['서울특별시'].sigungu.some((s) => s.name === '종로구'), false, 'LTC 행 혼입');
  assert.deepEqual(by['코드없음도'].names, ['코드없음도'], '코드 없는 행은 이름 그대로');
  // 응답에 공식 코드·id 는 나가지 않는다
  assert.equal(/360000|360200|H-0/.test(JSON.stringify(res.body)), false);
  // 조회: facilities 는 domain=eq.HOSPITAL 고정, facility_sources 는 코드 2개만
  for (const c of sb.calls.filter((x) => x.table === 'facilities')) {
    assert.ok(c.filters.some((f) => f.col === 'domain' && f.op === 'eq' && f.val === 'HOSPITAL'));
    assert.equal(c.params.limit, '1000');
  }
  const srcCalls = sb.calls.filter((x) => x.table === 'facility_sources');
  assert.ok(srcCalls.length >= 2, 'facility_sources 페이지 분할');
  for (const c of srcCalls) {
    assert.equal(c.params.select, 'facility_id,sido_cd:raw->basis->>sidoCd,sggu_cd:raw->basis->>sgguCd');
    assert.ok(c.filters.some((f) => f.col === 'source_system' && f.val === 'hira_hospital_ingest'));
  }
  assert.ok(sb.calls.every((c) => c.method === 'GET'));
});

test('regions: 선택지의 원본 이름 전부로 검색하면 같은 수 — 나주시 7곳 모두', async () => {
  const sb = makeMockSb(regionSeed());
  const r1 = await getRegions(sb);
  const asParam = (names) => (names.length === 1 ? names[0] : names);
  for (const reg of r1.body.regions) {
    const r2 = mkRes();
    // eslint-disable-next-line no-await-in-loop
    await HL(sb)({ method: 'GET', query: { sido: asParam(reg.names), size: '1' } }, r2);
    assert.equal(r2.statusCode, 200, reg.sido);
    assert.equal(r2.body.total, reg.count, reg.sido);
    for (const sg of reg.sigungu) {
      const r3 = mkRes();
      // eslint-disable-next-line no-await-in-loop
      await HL(sb)({ method: 'GET', query: { sido: asParam(reg.names), sigungu: asParam(sg.names), size: '50' } }, r3);
      assert.equal(r3.body.total, sg.count, `${reg.sido} ${sg.name}`);
    }
  }
  // 나주시: 원본 시도 이름이 다른 1곳까지 7곳
  const r4 = mkRes();
  await HL(sb)({ method: 'GET', query: { sido: ['전남광주', '전라남도'], sigungu: '나주시', size: '50' } }, r4);
  assert.equal(r4.body.total, 7);
  assert.deepEqual([...new Set(r4.body.items.map((it) => it.facility.sido))].sort(), ['전라남도', '전남광주'].sort(), '원본 시도 이름 그대로 응답');
  // 여러 이름은 in.(...) 하나로, 한 이름은 기존처럼 eq.
  const listCalls = sb.calls.filter((c) => c.table === 'facilities' && c.params.select && !c.params.select.startsWith('id,sido'));
  const last = listCalls[listCalls.length - 1];
  assert.ok(last.filters.some((f) => f.col === 'sido' && f.op === 'in' && f.val === '("전남광주","전라남도")'));
  assert.ok(last.filters.some((f) => f.col === 'sigungu_nm' && f.op === 'eq' && f.val === '나주시'));
});

test('regions: DB 오류 → 503, 내부 원문 미노출', async () => {
  const sb = async () => { throw new Error('secret-db-host connection refused'); };
  const res = mkRes();
  await HL(sb)({ method: 'GET', query: { view: 'regions' } }, res);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: 'db_unavailable' });
});

/* =====================================================================
 * C. 화면(hospital.js)
 * ===================================================================== */
const HJS = read('assets/js/hospital.js');

function makeDoc() {
  function mkEl(tagName) {
    const attrs = new Map();
    return {
      tagName: String(tagName || '').toUpperCase(), _text: '', children: [], _listeners: {}, disabled: false, _value: '',
      get value() {
        if (this.tagName !== 'SELECT') return this._value;
        return this.children.some((o) => o.value === this._value) ? this._value : '';
      },
      set value(v) { this._value = v == null ? '' : String(v); },
      get textContent() { return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text; },
      set textContent(v) { this.children = []; this._text = v == null ? '' : String(v); },
      get hidden() { return attrs.has('hidden'); },
      appendChild(c) { if (c && c._isFragment) { c.children.forEach((cc) => this.children.push(cc)); c.children = []; return c; } this.children.push(c); return c; },
      setAttribute(k, v) { attrs.set(k, String(v)); },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      removeAttribute(k) { attrs.delete(k); },
      hasAttribute(k) { return attrs.has(k); },
      addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
      dispatch(t, ev) { (this._listeners[t] || []).forEach((fn) => fn(ev || {})); },
      _matches(sel) { const m = sel.match(/^\[data-h="([^"]+)"\]$/); return m ? attrs.get('data-h') === m[1] : this.tagName === sel.toUpperCase(); },
      querySelector(sel) { const walk = (n) => { for (const c of n.children) { if (c._matches && c._matches(sel)) return c; const r = walk(c); if (r) return r; } return null; }; return walk(this); },
      querySelectorAll(sel) { const out = []; const walk = (n) => { for (const c of n.children) { if (c._matches && c._matches(sel)) out.push(c); walk(c); } }; walk(this); return out; },
    };
  }
  return {
    createElement: (t) => mkEl(t),
    createTextNode: (t) => { const e = mkEl('#text'); e._text = String(t); return e; },
    createDocumentFragment: () => { const f = mkEl('#fragment'); f._isFragment = true; return f; },
    getElementById: () => null, addEventListener: () => {}, title: '',
  };
}
function loadUI(doc) {
  const sandbox = { window: {}, globalThis: {}, module: { exports: {} }, URL, URLSearchParams, AbortController, console: { log() {}, warn() {}, error() {} }, document: doc };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(HJS, sandbox, { filename: 'hospital.js' });
  return sandbox.HospitalUI || sandbox.window.HospitalUI;
}
function makeSearchRoot() {
  const doc = makeDoc();
  const rootEl = doc.createElement('main');
  const mk = (h, tag) => { const e = doc.createElement(tag || 'div'); e.setAttribute('data-h', h); return e; };
  const els = {};
  for (const [h, tag] of [['prep', 'section'], ['search', 'section'], ['form', 'form'], ['q', 'input'], ['sido', 'select'], ['sigungu', 'select'],
    ['reset', 'button'], ['count'], ['list'], ['status', 'p'], ['pager', 'nav'], ['prev', 'button'], ['next', 'button'], ['pageinfo', 'span']]) els[h] = mk(h, tag);
  ['q', 'sido', 'sigungu', 'reset'].forEach((k) => els.form.appendChild(els[k]));
  ['form', 'count', 'status', 'list', 'pager'].forEach((k) => els.search.appendChild(els[k]));
  ['prev', 'pageinfo', 'next'].forEach((k) => els.pager.appendChild(els[k]));
  rootEl.appendChild(els.prep); rootEl.appendChild(els.search);
  return { doc, root: rootEl, els };
}
const mkFetchRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const REGIONS = { regions: [
  { sido: '서울특별시', names: ['서울특별시'], count: 2, sigungu: [{ name: '강남구', names: ['강남구'], count: 2 }] },
  { sido: '세종시', names: ['세종시'], count: 4, sigungu: [{ name: '세종시', names: ['세종시'], count: 4 }] },
  { sido: '전남광주', names: ['전남광주', '전라남도'], count: 22, sigungu: [{ name: '광주동구', names: ['광주동구'], count: 9 }, { name: '나주시', names: ['나주시'], count: 7 }, { name: '화순군', names: ['화순군'], count: 6 }] },
] };
function uiFetch(regionsRes) {
  const calls = [];
  const fn = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.startsWith('/api/flags')) return mkFetchRes(200, { hospital_module: true });
    if (u.indexOf('view=regions') >= 0) return regionsRes;
    if (u.startsWith('/api/hospital/facilities')) return mkFetchRes(200, { items: [], page: 1, size: 20, total: 0 });
    return mkFetchRes(404, {});
  };
  fn.calls = calls;
  return fn;
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const lastListQuery = (f) => new URLSearchParams((f.calls.filter((u) => u.startsWith('/api/hospital/facilities') && u.indexOf('view=regions') < 0).pop() || '?').split('?')[1]);
const optValues = (sel) => sel.children.map((o) => o.value);
async function initWith(search, regionsRes) {
  const { doc, root: r, els } = makeSearchRoot();
  const f = uiFetch(regionsRes || mkFetchRes(200, REGIONS));
  await loadUI(doc).initSearch(r, { fetch: f, history: { replaceState() {} }, location: { search, pathname: 'hospital.html' } });
  await tick();
  return { els, f };
}

test('화면: 시도 선택지 = API 선택지 이름(원본)만, 옛 표기는 따로 보이지 않음', async () => {
  const { els } = await initWith('');
  assert.deepEqual(optValues(els.sido), ['', '서울특별시', '세종시', '전남광주']);
  assert.deepEqual(els.sido.children.map((o) => o.textContent), ['전국', '서울특별시', '세종시', '전남광주']);
});

test('화면: 전남광주 › 나주시 → 묶인 원본 이름 전부로 검색(7곳 조건), 화면 선택값은 그대로', async () => {
  const { els, f } = await initWith('');
  els.sido.value = '전남광주';
  els.sido.dispatch('change');
  assert.deepEqual(optValues(els.sigungu), ['', '광주동구', '나주시', '화순군']);
  els.sigungu.value = '나주시';
  els.form.dispatch('submit', { preventDefault() {} });
  await tick();
  const sp = lastListQuery(f);
  assert.deepEqual(sp.getAll('sido'), ['전남광주', '전라남도']);
  assert.deepEqual(sp.getAll('sigungu'), ['나주시']);
  assert.equal(els.sido.value, '전남광주');
  assert.equal(els.sigungu.value, '나주시');
});

test('화면: 1:1 지역은 기존처럼 이름 1개로 검색', async () => {
  const { f } = await initWith('?sido=세종시&sigungu=세종시');
  const sp = lastListQuery(f);
  assert.deepEqual(sp.getAll('sido'), ['세종시']);
  assert.deepEqual(sp.getAll('sigungu'), ['세종시']);
});

test('화면: 예전 링크의 옛 표기(?sido=전라남도)는 같은 코드 묶음 선택지로 맞춘다', async () => {
  const { els, f } = await initWith('?sido=전라남도&sigungu=나주시');
  assert.equal(els.sido.value, '전남광주');
  assert.equal(els.sigungu.value, '나주시');
  const sp = lastListQuery(f);
  assert.deepEqual(sp.getAll('sido'), ['전남광주', '전라남도']);
});

test('화면: 목록에 없는 지역명(광주광역시 등)은 조건에서 빠진다 — 화면과 조건 불일치 0', async () => {
  const { els, f } = await initWith('?sido=광주광역시&sigungu=동구');
  const sp = lastListQuery(f);
  assert.equal(sp.get('sido'), null);
  assert.equal(sp.get('sigungu'), null);
  assert.equal(els.sido.value, '');
});

test('화면: 시도는 맞고 시군구만 목록에 없으면 시군구만 뺀다', async () => {
  const { els, f } = await initWith('?sido=전남광주&sigungu=동구');
  const sp = lastListQuery(f);
  assert.deepEqual(sp.getAll('sido'), ['전남광주', '전라남도']);
  assert.equal(sp.get('sigungu'), null);
  assert.equal(els.sido.value, '전남광주');
});

test('화면: 지역 목록을 못 받으면(503) 현재 조건만 선택지로 보여 주고 검색은 계속', async () => {
  const { els, f } = await initWith('?sido=세종시', mkFetchRes(503, { error: 'db_unavailable' }));
  assert.deepEqual(optValues(els.sido), ['', '세종시']);
  assert.equal(els.sido.value, '세종시');
  assert.deepEqual(lastListQuery(f).getAll('sido'), ['세종시']);
});

test('화면: flag OFF 면 지역 목록도 부르지 않는다', async () => {
  const { doc, root: r } = makeSearchRoot();
  const calls = [];
  const f = async (url) => { calls.push(String(url)); return mkFetchRes(200, { hospital_module: false }); };
  await loadUI(doc).initSearch(r, { fetch: f, history: { replaceState() {} }, location: { search: '', pathname: 'hospital.html' } });
  await tick();
  assert.equal(calls.filter((u) => u.indexOf('/api/hospital/') >= 0).length, 0);
});

test('buildListUrl: 묶인 이름은 최대 5개, 중복 제거, 값으로만 전달', () => {
  const UI = loadUI(makeDoc());
  const u = UI.buildListUrl({ sido: '전남광주', sigungu: '나주시', page: 1 }, { sido: ['전남광주', '전라남도', '전남광주', 'a', 'b', 'c', 'd'], sigungu: null });
  const sp = new URLSearchParams(u.split('?')[1]);
  assert.deepEqual(sp.getAll('sido'), ['전남광주', '전라남도', 'a', 'b']);
  assert.deepEqual(sp.getAll('sigungu'), ['나주시']);
  const u2 = UI.buildListUrl({ sido: '서울특별시&domain=eq.LTC', page: 1 });
  assert.deepEqual(new URLSearchParams(u2.split('?')[1]).getAll('sido'), ['서울특별시&domain=eq.LTC']);
});

test('정적: hospital.js 는 요양원용 지역표(REGIONS/SIGUNGU)로 병원 선택지를 만들지 않는다', () => {
  assert.equal(/\bREGIONS\b|\bSIGUNGU\b|\bSIDO_FULL\b/.test(HJS), false);
});

/* ---------------- 상세정보 상태 문구 ---------------- */
const NOT_COLLECTED = '상세정보를 아직 확인하지 못했습니다';
const EVAL_NONE = '제공된 자료에 평가 결과가 없습니다';
function detailText(data) {
  const doc = makeDoc();
  const UI = loadUI(doc);
  const box = doc.createElement('div');
  UI.renderDetail(box, data, {});
  return box.textContent;
}
const FAC = { id: 'H-1', name: '시험요양병원', address: '전남광주통합특별시 나주시 1', sido: '전남광주', sigungu_nm: '나주시', phone: '061-000-0000' };

test('상세: 미수집 → 확정 문구 1개, 평가 없음 문구·등급·"없음" 단정 없음, 기본정보는 표시', () => {
  const t = detailText({ facility: FAC, profile: { specialties: [], bed_total: null }, evaluation: null, detail_status: 'not_collected' });
  assert.ok(t.includes(NOT_COLLECTED));
  assert.equal(t.includes(EVAL_NONE), false);
  assert.ok(t.includes('시험요양병원') && t.includes('061-000-0000'));
  assert.equal(/0점|0등급|진료과목 없음|진료과 없음|등급 없음/.test(t), false);
});

test('상세: 수집됨 + 평가 없음 → 평가 문구, 등급 표시 없음', () => {
  const t = detailText({ facility: FAC, profile: { specialties: ['내과'] }, evaluation: null, detail_status: 'collected' });
  assert.ok(t.includes(EVAL_NONE));
  assert.equal(t.includes(NOT_COLLECTED), false);
  assert.equal(/등급/.test(t), false);
  assert.ok(t.includes('내과'));
});

test('상세: 수집됨 + 진료과 0개 → "진료과 없음"이라고 단정하지 않는다(칸 미표시)', () => {
  const t = detailText({ facility: FAC, profile: { specialties: [] }, evaluation: { grade: '2', evaluation_name: '요양병원 입원급여 적정성평가', evaluation_authority: 'HIRA' }, detail_status: 'collected' });
  assert.equal(/진료과목/.test(t), false);
  assert.equal(t.includes(NOT_COLLECTED) || t.includes(EVAL_NONE), false);
  assert.ok(t.includes('적정성평가'));
});

test('상세: 평가 있음은 기존 표시 그대로, detail_status 없는 옛 응답은 문구 없음', () => {
  const ev = { grade: '1', evaluation_name: '요양병원 입원급여 적정성평가', evaluation_authority: 'HIRA' };
  const t = detailText({ facility: FAC, profile: null, evaluation: ev, detail_status: 'collected' });
  assert.equal(t.includes(EVAL_NONE), false);
  const old = detailText({ facility: FAC, profile: null, evaluation: null });
  assert.equal(old.includes(NOT_COLLECTED) || old.includes(EVAL_NONE), false);
});

test('정적: 확정 문구가 코드에 그대로 있다', () => {
  assert.ok(HJS.includes(`'${NOT_COLLECTED}'`));
  assert.ok(HJS.includes(`'${EVAL_NONE}'`));
});
