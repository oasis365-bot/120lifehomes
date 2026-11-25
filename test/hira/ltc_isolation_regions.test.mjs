// 요양원(LTC) 화면 격리 + 요양병원 지역 선택지(view=regions) — 2026-11-25 Preview 시험에서 확인된 두 문제
//  1) hospital_module ON 이면 기존 요양원 검색·홈 목록에 요양병원이 섞이던 문제
//  2) HIRA 원본 지역명('전남광주', '세종시', '수원장안구' …)과 화면 선택지가 달라 필터 결과가 0 이던 문제
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
 * A. 기존 요양원 API (api/facilities.js · api/facility.js) — 실제 핸들러 + fetch 스텁
 * ===================================================================== */
process.env.SUPABASE_URL = 'https://db.example.test';
process.env.SUPABASE_SECRET_KEY = 'sb_secret_test_only';

let flagMode = 'fail'; // 'fail' | 'on' | 'off'
const seen = [];
globalThis.fetch = async (url) => {
  const u = decodeURIComponent(String(url));
  seen.push(u);
  if (u.includes('/rest/v1/feature_flags')) {
    if (flagMode === 'fail') return new Response('boom', { status: 500 });
    return new Response(JSON.stringify([{ key: 'hospital_module', enabled: flagMode === 'on' }]), { status: 200 });
  }
  if (u.includes('/rest/v1/facilities')) {
    return new Response('[]', { status: 200, headers: { 'content-range': '0-0/0' } });
  }
  return new Response('[]', { status: 200 });
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
  return { res, url: lastFacilitiesUrl() };
}

// 이 테스트는 반드시 첫 번째(이 프로세스에서 flag 표를 한 번도 못 읽은 상태)여야 한다.
test('요양원 목록: flag 표를 못 읽은 새 서버(schemaReady=false)도 요양병원 id(H-) 제외', async () => {
  flagMode = 'fail';
  const { res, url } = await callList({});
  assert.equal(res.statusCode, 200);
  assert.ok(url.includes('id=not.like.H-*'), url);
  assert.equal(url.includes('domain='), false, 'domain 컬럼 미참조(마이그레이션 전 호환)');
});

test('요양원 목록: flag OFF → domain=eq.LTC (domain 파라미터 무시)', async () => {
  flagMode = 'off';
  for (const domain of [undefined, 'HOSPITAL', 'ALL']) {
    const { url } = await callList(domain ? { domain } : {});
    assert.ok(url.includes('domain=eq.LTC'), `${domain}: ${url}`);
    assert.equal(url.includes('domain=eq.HOSPITAL'), false);
  }
});

test('요양원 목록: flag ON + domain 미지정(search.html·홈) → 요양원만', async () => {
  flagMode = 'on';
  for (const query of [{}, { sort: 'new', size: '3' }, { sido: '서울', page: '2' }, { domain: 'LTC' }, { domain: 'xyz' }]) {
    const { url } = await callList(query);
    assert.ok(url.includes('domain=eq.LTC'), `${JSON.stringify(query)}: ${url}`);
  }
});

test('요양원 목록: flag ON 에서도 HOSPITAL/ALL 은 명시할 때만', async () => {
  flagMode = 'on';
  assert.ok((await callList({ domain: 'HOSPITAL' })).url.includes('domain=eq.HOSPITAL'));
  assert.equal((await callList({ domain: 'ALL' })).url.includes('domain='), false);
});

test('요양원 상세: 요양병원 id(H-…) 는 flag ON/OFF 무관 404, DB 조회 0', async () => {
  for (const mode of ['on', 'off', 'fail']) {
    flagMode = mode;
    _resetFlagCache();
    seen.length = 0;
    const res = mkRes();
    await ltcDetail({ query: { id: 'H-abc' } }, res);
    assert.equal(res.statusCode, 404, mode);
    assert.equal(seen.length, 0, `${mode}: DB 조회 발생`);
  }
});

test('요양원 상세: 일반 id 는 flag ON/OFF 모두 domain=eq.LTC 로 조회', async () => {
  for (const mode of ['on', 'off']) {
    flagMode = mode;
    _resetFlagCache();
    seen.length = 0;
    await ltcDetail({ query: { id: '11111000006' } }, mkRes());
    const u = lastFacilitiesUrl();
    assert.ok(u.includes('id=eq.11111000006') && u.includes('domain=eq.LTC'), `${mode}: ${u}`);
  }
});

test('정적: 요양원 화면(search.html·index.html)은 그대로 — domain 을 보내지 않아도 서버가 요양원만 준다', () => {
  for (const f of ['search.html', 'index.html']) {
    assert.equal(/domain=|hospital/i.test(read(f).replace(/<!--[^]*?-->/g, '')), false, f);
  }
});

/* =====================================================================
 * B. GET /api/hospital/facilities?view=regions
 * ===================================================================== */
const flagsOn = async () => ({ flags: { hospital_module: true }, schemaReady: true });
const flagsOff = async () => ({ flags: {}, schemaReady: true });
const HL = (sb, getFlags = flagsOn) => createHospitalList({ sb, getFlags });

function regionSeed() {
  const rows = [];
  const add = (n, sido, sigungu_nm) => {
    for (let i = 0; i < n; i += 1) rows.push({ id: `H-${sido}-${sigungu_nm}-${i}`, name: 'x', sido, sigungu_nm, domain: 'HOSPITAL' });
  };
  add(9, '전남광주', '광주동구');
  add(12, '전남광주', '화순군');
  add(1, '전라남도', '화순군');
  add(4, '세종시', '세종시');
  add(3, '경기도', '수원장안구');
  add(1100, '서울특별시', '강남구'); // 1000 행 넘는 페이지 분할 확인
  rows.push({ id: '11111000006', name: '요양원', sido: '서울특별시', sigungu_nm: '종로구', domain: 'LTC' });
  return rows;
}

test('regions: flag OFF → 404, DB 조회 0', async () => {
  const sb = makeMockSb({ facilities: regionSeed() });
  const res = mkRes();
  await HL(sb, flagsOff)({ method: 'GET', query: { view: 'regions' } }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(sb.calls.length, 0);
});

test('regions: 잘못된 view → 400, DB 조회 0', async () => {
  const sb = makeMockSb({ facilities: regionSeed() });
  const res = mkRes();
  await HL(sb)({ method: 'GET', query: { view: 'all' } }, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'invalid_view' });
  assert.equal(sb.calls.length, 0);
});

test('regions: HIRA 원본 시도·시군구명을 바꾸지 않고, 요양병원 행만, 1000행 넘게도 집계', async () => {
  const sb = makeMockSb({ facilities: regionSeed() });
  const res = mkRes();
  await HL(sb)({ method: 'GET', query: { view: 'regions' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  const by = Object.fromEntries(res.body.regions.map((r) => [r.sido, r]));
  assert.deepEqual(Object.keys(by).sort(), ['경기도', '서울특별시', '세종시', '전남광주', '전라남도'].sort());
  // 치환·추정 없음: '전남광주' 는 광주/전남 어느 쪽으로도 바뀌지 않는다
  assert.equal(by['전남광주'].count, 21);
  assert.deepEqual(by['전남광주'].sigungu, [{ name: '광주동구', count: 9 }, { name: '화순군', count: 12 }]);
  assert.equal(by['전라남도'].count, 1);
  assert.equal(by['세종시'].count, 4);
  assert.deepEqual(by['경기도'].sigungu, [{ name: '수원장안구', count: 3 }]);
  assert.equal(by['서울특별시'].count, 1100, '페이지 분할 누락');
  assert.equal(by['서울특별시'].sigungu.some((s) => s.name === '종로구'), false, 'LTC 행 혼입');
  // 모든 조회가 domain=eq.HOSPITAL 고정 + 페이지 크기 1000
  const facCalls = sb.calls.filter((c) => c.table === 'facilities');
  assert.ok(facCalls.length >= 2);
  for (const c of facCalls) {
    assert.ok(c.filters.some((f) => f.col === 'domain' && f.op === 'eq' && f.val === 'HOSPITAL'));
    assert.equal(c.params.limit, '1000');
  }
});

test('regions: 돌려준 이름 그대로 목록 검색하면 같은 수가 나온다(화면=조건)', async () => {
  const sb = makeMockSb({ facilities: regionSeed() });
  const r1 = mkRes();
  await HL(sb)({ method: 'GET', query: { view: 'regions' } }, r1);
  for (const reg of r1.body.regions) {
    const r2 = mkRes();
    // eslint-disable-next-line no-await-in-loop
    await HL(sb)({ method: 'GET', query: { sido: reg.sido, size: '1' } }, r2);
    assert.equal(r2.body.total, reg.count, reg.sido);
    for (const sg of reg.sigungu) {
      const r3 = mkRes();
      // eslint-disable-next-line no-await-in-loop
      await HL(sb)({ method: 'GET', query: { sido: reg.sido, sigungu: sg.name, size: '1' } }, r3);
      assert.equal(r3.body.total, sg.count, `${reg.sido} ${sg.name}`);
    }
  }
});

test('regions: DB 오류 → 503, 내부 원문 미노출', async () => {
  const sb = async () => { throw new Error('secret-db-host connection refused'); };
  const res = mkRes();
  await HL(sb)({ method: 'GET', query: { view: 'regions' } }, res);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: 'db_unavailable' });
});

/* =====================================================================
 * C. 화면(hospital.js) — 지역 선택지는 API 값만, 화면 선택값 = 요청 조건
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
  const root = doc.createElement('main');
  const mk = (h, tag) => { const e = doc.createElement(tag || 'div'); e.setAttribute('data-h', h); return e; };
  const els = {};
  for (const [h, tag] of [['prep', 'section'], ['search', 'section'], ['form', 'form'], ['q', 'input'], ['sido', 'select'], ['sigungu', 'select'],
    ['reset', 'button'], ['count'], ['list'], ['status', 'p'], ['pager', 'nav'], ['prev', 'button'], ['next', 'button'], ['pageinfo', 'span']]) els[h] = mk(h, tag);
  ['q', 'sido', 'sigungu', 'reset'].forEach((k) => els.form.appendChild(els[k]));
  ['form', 'count', 'status', 'list', 'pager'].forEach((k) => els.search.appendChild(els[k]));
  ['prev', 'pageinfo', 'next'].forEach((k) => els.pager.appendChild(els[k]));
  root.appendChild(els.prep); root.appendChild(els.search);
  return { doc, root, els };
}
const mkFetchRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const REGIONS = { regions: [
  { sido: '서울특별시', count: 2, sigungu: [{ name: '강남구', count: 2 }] },
  { sido: '세종시', count: 4, sigungu: [{ name: '세종시', count: 4 }] },
  { sido: '전남광주', count: 21, sigungu: [{ name: '광주동구', count: 9 }, { name: '화순군', count: 12 }] },
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
const listCalls = (f) => f.calls.filter((u) => u.startsWith('/api/hospital/facilities') && u.indexOf('view=regions') < 0);
const optValues = (sel) => sel.children.map((o) => o.value);

test('화면: 시도 선택지 = API 지역 목록(원본 그대로), 시군구 = 그 시도의 목록', async () => {
  const { doc, root, els } = makeSearchRoot();
  const f = uiFetch(mkFetchRes(200, REGIONS));
  await loadUI(doc).initSearch(root, { fetch: f, history: { replaceState() {} }, location: { search: '', pathname: 'hospital.html' } });
  await tick();
  assert.deepEqual(optValues(els.sido), ['', '서울특별시', '세종시', '전남광주']);
  els.sido.value = '전남광주';
  els.sido.dispatch('change');
  assert.deepEqual(optValues(els.sigungu), ['', '광주동구', '화순군']);
  els.sigungu.value = '광주동구';
  els.form.dispatch('submit', { preventDefault() {} });
  await tick();
  const sp = new URLSearchParams(listCalls(f).pop().split('?')[1]);
  assert.equal(sp.get('sido'), '전남광주');
  assert.equal(sp.get('sigungu'), '광주동구');
});

test('화면: 목록에 없는 예전 지역명(광주광역시 등)은 조건에서 빠진다 — 화면과 조건 불일치 0', async () => {
  const { doc, root, els } = makeSearchRoot();
  const f = uiFetch(mkFetchRes(200, REGIONS));
  await loadUI(doc).initSearch(root, { fetch: f, history: { replaceState() {} }, location: { search: '?sido=광주광역시&sigungu=동구', pathname: 'hospital.html' } });
  await tick();
  const sp = new URLSearchParams(listCalls(f).pop().split('?')[1] || '');
  assert.equal(sp.get('sido'), null);
  assert.equal(sp.get('sigungu'), null);
  assert.equal(els.sido.value, '');
});

test('화면: 시도는 맞고 시군구만 목록에 없으면 시군구만 뺀다', async () => {
  const { doc, root, els } = makeSearchRoot();
  const f = uiFetch(mkFetchRes(200, REGIONS));
  await loadUI(doc).initSearch(root, { fetch: f, history: { replaceState() {} }, location: { search: '?sido=전남광주&sigungu=동구', pathname: 'hospital.html' } });
  await tick();
  const sp = new URLSearchParams(listCalls(f).pop().split('?')[1]);
  assert.equal(sp.get('sido'), '전남광주');
  assert.equal(sp.get('sigungu'), null);
  assert.equal(els.sido.value, '전남광주');
});

test('화면: 지역 목록을 못 받으면(503) 현재 조건만 선택지로 보여 주고 검색은 계속', async () => {
  const { doc, root, els } = makeSearchRoot();
  const f = uiFetch(mkFetchRes(503, { error: 'db_unavailable' }));
  await loadUI(doc).initSearch(root, { fetch: f, history: { replaceState() {} }, location: { search: '?sido=세종시', pathname: 'hospital.html' } });
  await tick();
  assert.deepEqual(optValues(els.sido), ['', '세종시']);
  assert.equal(els.sido.value, '세종시');
  const sp = new URLSearchParams(listCalls(f).pop().split('?')[1]);
  assert.equal(sp.get('sido'), '세종시');
});

test('화면: flag OFF 면 지역 목록도 부르지 않는다', async () => {
  const { doc, root } = makeSearchRoot();
  const calls = [];
  const f = async (url) => { calls.push(String(url)); return mkFetchRes(200, { hospital_module: false }); };
  await loadUI(doc).initSearch(root, { fetch: f, history: { replaceState() {} }, location: { search: '', pathname: 'hospital.html' } });
  await tick();
  assert.equal(calls.filter((u) => u.indexOf('/api/hospital/') >= 0).length, 0);
});

test('정적: hospital.js 는 요양원용 지역표(REGIONS/SIGUNGU)로 병원 선택지를 만들지 않는다', () => {
  assert.equal(/\bREGIONS\b|\bSIGUNGU\b|\bSIDO_FULL\b/.test(HJS), false);
});
