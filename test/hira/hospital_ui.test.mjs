// 요양병원 검색·상세 화면 (1B-4D) — assets/js/hospital.js 렌더링·보안·계약 테스트
// 외부 의존성 없음: 최소 DOM 스텁 + node:vm 으로 hospital.js 로드.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => readFileSync(root + p, 'utf8');
const HJS = read('assets/js/hospital.js');

/* ---------------- 최소 DOM 스텁 ---------------- */
function makeDoc() {
  function mkEl(tagName) {
    const attrs = new Map();
    const node = {
      tagName: String(tagName || '').toUpperCase(),
      _text: '',
      className: '',
      children: [],
      _listeners: {},
      disabled: false,
      value: '',
      get textContent() {
        if (this.children.length === 0) return this._text;
        return this.children.map((c) => c.textContent).join('');
      },
      set textContent(v) { this.children = []; this._text = v == null ? '' : String(v); },
      get hidden() { return attrs.has('hidden'); },
      appendChild(c) {
        if (c && c._isFragment) { c.children.forEach((cc) => this.children.push(cc)); c.children = []; return c; }
        this.children.push(c); return c;
      },
      removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
      remove() {},
      setAttribute(k, v) { attrs.set(k, String(v)); },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      removeAttribute(k) { attrs.delete(k); },
      hasAttribute(k) { return attrs.has(k); },
      addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
      dispatch(type, ev) { (this._listeners[type] || []).forEach((fn) => fn(ev || {})); },
      _matches(sel) {
        const m = sel.match(/^\[data-h="([^"]+)"\]$/);
        if (m) return attrs.get('data-h') === m[1];
        return this.tagName === sel.toUpperCase();
      },
      querySelector(sel) {
        const walk = (n) => {
          for (const c of n.children) {
            if (c._matches && c._matches(sel)) return c;
            const r = walk(c);
            if (r) return r;
          }
          return null;
        };
        return walk(this);
      },
      querySelectorAll(sel) {
        const out = [];
        const walk = (n) => { for (const c of n.children) { if (c._matches && c._matches(sel)) out.push(c); walk(c); } };
        walk(this);
        return out;
      },
      // 재귀 텍스트/태그 수집 (테스트 검증용)
      _allTags() { const out = [this.tagName]; this.children.forEach((c) => { if (c._allTags) out.push(...c._allTags()); }); return out; },
    };
    return node;
  }
  return {
    createElement: (t) => mkEl(t),
    createDocumentFragment: () => { const f = mkEl('#fragment'); f._isFragment = true; return f; },
    getElementById: () => null,
    addEventListener: () => {},
    title: '',
  };
}

function loadUI(documentStub) {
  const sandbox = {
    window: {}, globalThis: {}, module: { exports: {} },
    URL, URLSearchParams, AbortController,
    console: { log() {}, warn() {}, error() {} },
  };
  if (documentStub) sandbox.document = documentStub;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(HJS, sandbox, { filename: 'hospital.js' });
  return sandbox.HospitalUI || sandbox.window.HospitalUI;
}

const mkRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, opt) => {
    const u = String(url);
    calls.push({ url: u, opt: opt || {} });
    for (const [pat, handler] of routes) {
      if (u.startsWith(pat)) return typeof handler === 'function' ? handler(u, opt) : handler;
    }
    return mkRes(404, { error: 'not_found' });
  };
  fn.calls = calls;
  return fn;
}

/* ---------------- 정적: 안전한 DOM 방식 ---------------- */
test('정적: hospital.js 는 innerHTML/insertAdjacentHTML/document.write 를 쓰지 않는다', () => {
  const codeOnly = HJS.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(/\.innerHTML\s*=/.test(codeOnly), false, 'innerHTML 할당');
  assert.equal(/insertAdjacentHTML/.test(codeOnly), false);
  assert.equal(/document\.write/.test(codeOnly), false);
  assert.equal(/\bouterHTML\b/.test(codeOnly), false);
});

test('정적: raw / ykiho / external_id / hash / source 상태 필드를 참조하지 않는다', () => {
  const codeOnly = HJS.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const bad of ['hira_ykiho', 'external_id', 'normalized_hash', '\\.raw\\b', 'source_reference', 'ingestion']) {
    assert.equal(new RegExp(bad).test(codeOnly), false, `${bad} 참조`);
  }
});

test('정적: node:vm 로 문법 검사 통과 (node --check 대용)', () => {
  assert.doesNotThrow(() => new vm.Script(HJS, { filename: 'hospital.js' }));
});

/* ---------------- 순수 헬퍼 ---------------- */
test('safeExternalUrl: http/https 만 허용, javascript:/data: 등 차단', () => {
  const UI = loadUI();
  assert.equal(UI.safeExternalUrl('https://ex.example.kr/a'), 'https://ex.example.kr/a');
  assert.equal(UI.safeExternalUrl('http://ex.example.kr'), 'http://ex.example.kr/');
  assert.equal(UI.safeExternalUrl('ex.example.kr'), 'https://ex.example.kr/'); // 스킴 없으면 https 보정
  assert.equal(UI.safeExternalUrl('javascript:alert(1)'), null);
  assert.equal(UI.safeExternalUrl('JavaScript:alert(1)'), null);
  assert.equal(UI.safeExternalUrl('data:text/html,<script>x</script>'), null);
  assert.equal(UI.safeExternalUrl('mailto:a@b.c'), null);
  assert.equal(UI.safeExternalUrl('vbscript:msgbox(1)'), null);
  assert.equal(UI.safeExternalUrl('  '), null);
  assert.equal(UI.safeExternalUrl(null), null);
  assert.equal(UI.safeExternalUrl('not a url at all !!!'), null);
});

test('buildListUrl: q/sido/sigungu/page/size 를 URLSearchParams 로만 만든다', () => {
  const UI = loadUI();
  const u = UI.buildListUrl({ q: '서울 병원', sido: '서울특별시', sigungu: '강남구', page: 3 });
  assert.ok(u.startsWith('/api/hospital/facilities?'));
  const sp = new URLSearchParams(u.split('?')[1]);
  assert.equal(sp.get('q'), '서울 병원');
  assert.equal(sp.get('sido'), '서울특별시');
  assert.equal(sp.get('sigungu'), '강남구');
  assert.equal(sp.get('page'), '3');
  assert.equal(sp.get('size'), '20');
  // 구조 주입 시도: & = ? # 가 값 안에서 인코딩됨 → 파라미터 키는 6개뿐
  const u2 = UI.buildListUrl({ q: '서울&domain=eq.LTC&page=99', page: 1 });
  const sp2 = new URLSearchParams(u2.split('?')[1]);
  assert.deepEqual([...new Set([...sp2.keys()])].sort(), ['page', 'q', 'size']);
  assert.equal(sp2.get('q'), '서울&domain=eq.LTC&page=99');
  assert.equal(sp2.get('page'), '1');
});

test('buildDetailUrl: id 를 URLSearchParams 로만', () => {
  const UI = loadUI();
  const u = UI.buildDetailUrl('H-abc/def+g');
  assert.ok(u.startsWith('/api/hospital/facility?'));
  assert.equal(new URLSearchParams(u.split('?')[1]).get('id'), 'H-abc/def+g');
});

test('userErrorMessage: 상태코드별 안전 문구 (내부정보 없음)', () => {
  const UI = loadUI();
  for (const s of [400, 404, 503, 500, undefined]) {
    const m = UI.userErrorMessage(s);
    assert.ok(m && m.length > 5);
    assert.equal(/http|stack|api\/|supabase|Error:|undefined/i.test(m), false, `문구에 내부정보: ${m}`);
  }
  assert.notEqual(UI.userErrorMessage(400), UI.userErrorMessage(503));
});

test('gradeLabel: 1~5 → N등급, 그 외 원문 유지(환산 없음)', () => {
  const UI = loadUI();
  assert.equal(UI.gradeLabel('1'), '1등급');
  assert.equal(UI.gradeLabel('5'), '5등급');
  assert.equal(UI.gradeLabel('등급제외'), '등급제외');
  assert.equal(UI.gradeLabel(''), '');
  assert.equal(UI.gradeLabel(null), '');
  assert.equal(/[A-E]/.test(UI.gradeLabel('3')), false);
});

/* ---------------- 목록 카드 렌더링 ---------------- */
function cardText(node) { return node.textContent; }

test('facilityCard: 공개값만, null 은 "정보 없음" 규칙', () => {
  const UI = loadUI(makeDoc());
  const card = UI.facilityCard({
    facility: { id: 'H-x1', name: '가나요양병원', address: '서울특별시 강남구 1', phone: null, established_at: '2015-01-02' },
    profile: { establishment_type: '의료법인', bed_total: 200, specialties: ['내과', '외과', '재활의학과', '정형외과', '신경과', '가정의학과'] },
    evaluation: { grade: '2', evaluation_name: '요양병원 입원급여 적정성평가' },
  });
  const txt = cardText(card);
  assert.ok(txt.includes('가나요양병원'));
  assert.ok(txt.includes('서울특별시 강남구 1'));
  assert.ok(txt.includes('정보 없음')); // phone 없음
  assert.ok(txt.includes('2015.01.02'));
  assert.ok(txt.includes('200병상'));
  assert.ok(txt.includes('적정성평가 2등급'));
  assert.ok(txt.includes('+1')); // specialties 5개 표시 + 나머지 1
  // 상세 링크
  const link = card.querySelectorAll('A').find((a) => a.getAttribute('href') && a.getAttribute('href').indexOf('hospital-facility.html') === 0);
  assert.ok(link);
  assert.equal(new URLSearchParams(link.getAttribute('href').split('?')[1]).get('id'), 'H-x1');
});

test('facilityCard: profile/evaluation 없어도 렌더', () => {
  const UI = loadUI(makeDoc());
  const card = UI.facilityCard({ facility: { id: 'H-x2', name: '나다요양병원', address: null } });
  const txt = cardText(card);
  assert.ok(txt.includes('나다요양병원'));
  assert.ok(txt.includes('정보 없음'));
  assert.equal(/undefined|null|NaN/.test(txt), false);
});

test('보안: 악성 병원명·주소·진료과목이 HTML 로 실행되지 않는다', () => {
  const UI = loadUI(makeDoc());
  const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const card = UI.facilityCard({
    facility: { id: '<b>id</b>', name: evil, address: '"><svg onload=alert(3)>' },
    profile: { specialties: ['<iframe src=javascript:alert(4)>'] },
  });
  // 생성된 요소 트리에 IMG/SCRIPT/IFRAME/SVG 태그가 없다
  const tags = card._allTags();
  for (const t of ['IMG', 'SCRIPT', 'IFRAME', 'SVG', 'B']) assert.equal(tags.includes(t), false, `${t} 생성됨`);
  // 악성 문자열은 그대로 텍스트로만 존재
  assert.ok(card.textContent.includes(evil));
});

test('renderList: 카드 목록을 textContent 초기화 후 채운다', () => {
  const UI = loadUI(makeDoc());
  const doc = makeDoc();
  const cont = doc.createElement('div');
  cont.textContent = '이전내용';
  UI.renderList(cont, [
    { facility: { id: 'H-1', name: 'A병원' } },
    { facility: { id: 'H-2', name: 'B병원' } },
  ], '?q=A');
  assert.equal(cont.children.length, 2);
  assert.ok(cont.textContent.includes('A병원'));
  assert.equal(cont.textContent.includes('이전내용'), false);
  // backSearch 가 상세 링크 from 에 전달됨
  const a = cont.querySelectorAll('A').find((x) => (x.getAttribute('href') || '').indexOf('hospital-facility.html') === 0);
  assert.equal(new URLSearchParams(a.getAttribute('href').split('?')[1]).get('from'), 'q=A');
});

/* ---------------- 상세 렌더링 ---------------- */
test('renderDetail: 전 섹션 + medical_services 는 보류(렌더 안 함)', () => {
  const UI = loadUI(makeDoc());
  const doc = makeDoc();
  const cont = doc.createElement('div');
  UI.renderDetail(cont, {
    facility: { id: 'H-9', name: '다라요양병원', address: '경기도 성남시 분당구 2', phone: '031-000-0000', sido: '경기도', sigungu_nm: '성남시 분당구', established_at: '2010-05-06' },
    profile: {
      establishment_type: '의료법인', bed_total: 250,
      bed_detail: { standard: 212, higher: 38, rooms: { operating: 2, emergency: 1 } },
      specialties: ['내과', '재활의학과'],
      specialist_counts: { 내과: 3, 재활의학과: 2 },
      equipment: [{ code: 'B101', name: '일반엑스선촬영장치', count: 1 }],
      medical_services: { dialysis: 'FACILITY_CLAIMED' },
      homepage: 'https://example-hospital.kr',
    },
    evaluation: { evaluation_authority: 'HIRA', evaluation_name: '요양병원 입원급여 적정성평가', evaluation_year: null, grade: '1', grade_scale: 'HIRA_1_5', collected_at: '2025-06-01T00:00:00.000Z' },
  }, { backSearch: '?sido=경기도' });

  const txt = cont.textContent;
  assert.ok(txt.includes('다라요양병원'));
  assert.ok(txt.includes('경기도 성남시 분당구 2'));
  assert.ok(txt.includes('의료법인'));
  assert.ok(txt.includes('2010.05.06'));
  assert.ok(txt.includes('허가 병상 총수'));
  assert.ok(txt.includes('일반 병상'));
  assert.ok(txt.includes('수술실'));
  assert.ok(txt.includes('내과'));
  assert.ok(txt.includes('전문의 현황'));
  assert.ok(txt.includes('일반엑스선촬영장치'));
  assert.ok(txt.includes('1등급'));
  assert.ok(txt.includes('2025.06.01'));
  assert.ok(txt.includes('환산하지 않'));
  // medical_services 상태 문자열은 화면에 절대 안 나온다
  for (const s of ['FACILITY_CLAIMED', 'VERIFIED_TRUE', 'VERIFIED_FALSE', 'UNKNOWN', 'dialysis', 'medical_services']) {
    assert.equal(txt.includes(s), false, `medical_services 관련 "${s}" 노출`);
  }
  // 홈페이지 안전 링크
  const hp = cont.querySelectorAll('A').find((a) => (a.getAttribute('href') || '').indexOf('http') === 0);
  assert.equal(hp.getAttribute('href'), 'https://example-hospital.kr/');
  assert.equal(hp.getAttribute('rel'), 'noopener noreferrer nofollow');
  // 목록으로 링크가 backSearch 유지
  const back = cont.querySelectorAll('A').find((a) => (a.getAttribute('href') || '').indexOf('hospital.html') === 0);
  assert.equal(back.getAttribute('href'), 'hospital.html?sido=경기도');
});

test('renderDetail: 위험한 homepage 는 링크로 만들지 않는다', () => {
  const UI = loadUI(makeDoc());
  const doc = makeDoc();
  const cont = doc.createElement('div');
  UI.renderDetail(cont, {
    facility: { id: 'H-9', name: 'x', address: 'a' },
    profile: { homepage: 'javascript:alert(1)' },
  }, {});
  const links = cont.querySelectorAll('A').map((a) => a.getAttribute('href') || '');
  assert.equal(links.some((h) => h.indexOf('javascript:') === 0), false);
  assert.equal(cont.textContent.includes('javascript:'), false);
});

test('renderDetail: 값 없는 항목은 "정보 없음" 또는 섹션 생략, undefined 노출 없음', () => {
  const UI = loadUI(makeDoc());
  const doc = makeDoc();
  const cont = doc.createElement('div');
  UI.renderDetail(cont, { facility: { id: 'H-0', name: '빈요양병원' }, profile: null, evaluation: null }, {});
  const txt = cont.textContent;
  assert.ok(txt.includes('빈요양병원'));
  assert.ok(txt.includes('정보 없음'));
  assert.equal(/undefined|null|NaN|\[object/.test(txt), false);
  assert.equal(txt.includes('병상 정보'), false); // 병상 섹션 생략
  assert.equal(txt.includes('전문의 현황'), false);
});

/* ---------------- 컨트롤러: 검색 ---------------- */
function makeSearchRoot() {
  const doc = makeDoc();
  const root = doc.createElement('main');
  const mk = (h, tag) => { const e = doc.createElement(tag || 'div'); e.setAttribute('data-h', h); return e; };
  const prep = mk('prep', 'section'); prep.setAttribute('hidden', 'hidden');
  const search = mk('search', 'section'); search.setAttribute('hidden', 'hidden');
  const form = mk('form', 'form');
  const q = mk('q', 'input'); const sido = mk('sido', 'select'); const sigungu = mk('sigungu', 'select');
  const reset = mk('reset', 'button');
  const count = mk('count'); const list = mk('list'); const status = mk('status', 'p'); status.setAttribute('hidden', 'hidden');
  const pager = mk('pager', 'nav'); pager.setAttribute('hidden', 'hidden');
  const prev = mk('prev', 'button'); const next = mk('next', 'button'); const pageinfo = mk('pageinfo', 'span');
  form.appendChild(q); form.appendChild(sido); form.appendChild(sigungu); form.appendChild(reset);
  search.appendChild(form); search.appendChild(count); search.appendChild(status); search.appendChild(list);
  pager.appendChild(prev); pager.appendChild(pageinfo); pager.appendChild(next); search.appendChild(pager);
  root.appendChild(prep); root.appendChild(search);
  return { doc, root, els: { prep, search, form, q, sido, sigungu, reset, count, list, status, pager, prev, next } };
}

test('컨트롤러: flag=false → 준비 중 화면, 병원 API 호출 0', async () => {
  const { doc, root, els } = makeSearchRoot();
  const UI = loadUI(doc);
  const f = fakeFetch([['/api/flags', mkRes(200, { hospital_module: false })]]);
  await UI.initSearch(root, { fetch: f, history: { replaceState() {} }, location: { search: '', pathname: 'hospital.html' } });
  assert.equal(els.prep.hidden, false);
  assert.equal(els.search.hidden, true);
  assert.equal(f.calls.filter((c) => c.url.indexOf('/api/hospital/') >= 0).length, 0, '병원 API 호출됨');
});

test('컨트롤러: flag=true → 검색 UI 표시 + 첫 요청 q/sido/sigungu/page 정확', async () => {
  const { doc, root, els } = makeSearchRoot();
  const UI = loadUI(doc);
  let seen = null;
  const f = fakeFetch([
    ['/api/flags', mkRes(200, { hospital_module: true })],
    ['/api/hospital/facilities', (url) => { seen = url; return mkRes(200, { items: [{ facility: { id: 'H-1', name: 'A병원' } }], page: 2, size: 20, total: 25 }); }],
  ]);
  await UI.initSearch(root, {
    fetch: f, history: { replaceState() {} },
    location: { search: '?q=요양&sido=서울특별시&sigungu=강남구&page=2', pathname: 'hospital.html' },
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(els.prep.hidden, true);
  assert.equal(els.search.hidden, false);
  const sp = new URLSearchParams(seen.split('?')[1]);
  assert.equal(sp.get('q'), '요양');
  assert.equal(sp.get('sido'), '서울특별시');
  assert.equal(sp.get('sigungu'), '강남구');
  assert.equal(sp.get('page'), '2');
  assert.ok(els.list.textContent.includes('A병원'));
  assert.ok(els.count.textContent.includes('25'));
  assert.equal(els.pager.hidden, false); // total(25) > size(20)
});

test('컨트롤러: 검색/초기화/이전/다음', async () => {
  const { doc, root, els } = makeSearchRoot();
  const UI = loadUI(doc);
  const pages = { 1: { items: new Array(20).fill(0).map((_, i) => ({ facility: { id: 'H' + i, name: 'p1_' + i } })), page: 1, size: 20, total: 30 },
    2: { items: new Array(10).fill(0).map((_, i) => ({ facility: { id: 'H2' + i, name: 'p2_' + i } })), page: 2, size: 20, total: 30 } };
  const f = fakeFetch([
    ['/api/flags', mkRes(200, { hospital_module: true })],
    ['/api/hospital/facilities', (url) => { const p = new URLSearchParams(url.split('?')[1]).get('page'); return mkRes(200, pages[p] || pages[1]); }],
  ]);
  await UI.initSearch(root, { fetch: f, history: { replaceState() {} }, location: { search: '', pathname: 'hospital.html' } });
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(els.list.textContent.includes('p1_0'));
  // 다음
  els.next.dispatch('click');
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(els.list.textContent.includes('p2_0'));
  assert.equal(els.list.textContent.includes('p1_0'), false);
  assert.equal(els.next.disabled, true); // 마지막 페이지
  // 이전
  els.prev.dispatch('click');
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(els.list.textContent.includes('p1_0'));
  // 검색어 입력 후 submit → page 1 로
  els.q.value = '재활';
  els.form.dispatch('submit', { preventDefault() {} });
  await new Promise((r) => setTimeout(r, 0));
  const lastCall = f.calls[f.calls.length - 1].url;
  assert.equal(new URLSearchParams(lastCall.split('?')[1]).get('q'), '재활');
  assert.equal(new URLSearchParams(lastCall.split('?')[1]).get('page'), '1');
  // 초기화
  els.reset.dispatch('click');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(els.q.value, '');
});

test('컨트롤러: 빈 결과 → 안내 문구, 오류 → 상태코드별 안전 문구', async () => {
  const { doc, root, els } = makeSearchRoot();
  const UI = loadUI(doc);
  let mode = 'empty';
  const f = fakeFetch([
    ['/api/flags', mkRes(200, { hospital_module: true })],
    ['/api/hospital/facilities', () => (mode === 'empty' ? mkRes(200, { items: [], page: 1, size: 20, total: 0 })
      : mode === '503' ? mkRes(503, { error: 'db_unavailable' })
        : mkRes(400, { error: 'invalid_q' }))],
  ]);
  const ready = {};
  await UI.initSearch(root, { fetch: f, history: { replaceState() {} }, location: { search: '', pathname: 'hospital.html' }, onReady: (api) => { ready.run = api.run; } });
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(els.status.textContent.includes('없습니다'));
  assert.equal(els.pager.hidden, true);

  mode = '503'; ready.run(false); await new Promise((r) => setTimeout(r, 0));
  assert.ok(els.status.textContent.includes('잠시 후'));
  assert.equal(/db_unavailable|http|503/.test(els.status.textContent), false);

  mode = '400'; ready.run(false); await new Promise((r) => setTimeout(r, 0));
  assert.ok(els.status.textContent.includes('조건'));
});

test('컨트롤러: 최신 요청만 화면에 반영 (경쟁 응답 무시)', async () => {
  const { doc, root, els } = makeSearchRoot();
  const UI = loadUI(doc);
  const resolvers = [];
  const f = (url) => {
    if (String(url).indexOf('/api/flags') >= 0) return Promise.resolve(mkRes(200, { hospital_module: true }));
    return new Promise((resolve) => { resolvers.push({ url: String(url), resolve }); });
  };
  f.calls = [];
  const ready = {};
  await UI.initSearch(root, { fetch: f, history: { replaceState() {} }, location: { search: '', pathname: 'hospital.html' }, onReady: (api) => { ready.run = api.run; } });
  // 첫 자동 run 이 pending. 두 번째 run 시작.
  els.q.value = '두번째';
  els.form.dispatch('submit', { preventDefault() {} });
  // 이제 resolvers[0] = 첫(오래된) 요청, resolvers[1] = 두번째(최신)
  assert.ok(resolvers.length >= 2);
  const older = resolvers[0]; const newer = resolvers[resolvers.length - 1];
  newer.resolve(mkRes(200, { items: [{ facility: { id: 'H-new', name: '최신결과' } }], page: 1, size: 20, total: 1 }));
  await new Promise((r) => setTimeout(r, 0));
  older.resolve(mkRes(200, { items: [{ facility: { id: 'H-old', name: '오래된결과' } }], page: 1, size: 20, total: 1 }));
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(els.list.textContent.includes('최신결과'));
  assert.equal(els.list.textContent.includes('오래된결과'), false);
});

/* ---------------- 컨트롤러: 상세 ---------------- */
function makeDetailRoot() {
  const doc = makeDoc();
  const root = doc.createElement('main');
  const mk = (h, tag) => { const e = doc.createElement(tag || 'div'); e.setAttribute('data-h', h); e.setAttribute('hidden', 'hidden'); return e; };
  const prep = mk('prep', 'section'); const status = mk('status', 'p'); const body = mk('body', 'section');
  root.appendChild(prep); root.appendChild(status); root.appendChild(body);
  return { doc, root, els: { prep, status, body } };
}

test('상세 컨트롤러: flag=false → 준비 중, API 호출 0', async () => {
  const { doc, root, els } = makeDetailRoot();
  const UI = loadUI(doc);
  const f = fakeFetch([['/api/flags', mkRes(200, { hospital_module: false })]]);
  await UI.initDetail(root, { fetch: f, location: { search: '?id=H-1' } });
  assert.equal(els.prep.hidden, false);
  assert.equal(f.calls.filter((c) => c.url.indexOf('/api/hospital/facility') >= 0).length, 0);
});

test('상세 컨트롤러: flag=true 정상/없음/오류', async () => {
  const UI = loadUI(makeDoc());
  // 정상
  let { doc, root, els } = makeDetailRoot();
  let f = fakeFetch([
    ['/api/flags', mkRes(200, { hospital_module: true })],
    ['/api/hospital/facility', mkRes(200, { facility: { id: 'H-1', name: '정상요양병원', address: '서울 1' }, profile: null, evaluation: null })],
  ]);
  await UI.initDetail(root, { fetch: f, location: { search: '?id=H-1&from=' + encodeURIComponent('sido=서울특별시&page=2') } });
  assert.equal(els.body.hidden, false);
  assert.ok(els.body.textContent.includes('정상요양병원'));
  const back = els.body.querySelectorAll('A').find((a) => (a.getAttribute('href') || '').indexOf('hospital.html') === 0);
  const bsp0 = new URLSearchParams(back.getAttribute('href').split('?')[1]);
  assert.equal(bsp0.get('sido'), '서울특별시');
  assert.equal(bsp0.get('page'), '2');

  // 없음 (200 이지만 facility 없음)
  ({ doc, root, els } = makeDetailRoot());
  f = fakeFetch([
    ['/api/flags', mkRes(200, { hospital_module: true })],
    ['/api/hospital/facility', mkRes(404, { error: 'not_found' })],
  ]);
  await UI.initDetail(root, { fetch: f, location: { search: '?id=H-x' } });
  assert.ok(els.body.textContent.includes('찾을 수 없습니다'));

  // 503 오류
  ({ doc, root, els } = makeDetailRoot());
  f = fakeFetch([
    ['/api/flags', mkRes(200, { hospital_module: true })],
    ['/api/hospital/facility', mkRes(503, { error: 'db_unavailable' })],
  ]);
  await UI.initDetail(root, { fetch: f, location: { search: '?id=H-y' } });
  assert.ok(els.status.textContent.includes('잠시 후'));
  assert.equal(/db_unavailable|503|http/.test(els.status.textContent + els.body.textContent), false);

  // id 없음
  ({ doc, root, els } = makeDetailRoot());
  f = fakeFetch([['/api/flags', mkRes(200, { hospital_module: true })]]);
  await UI.initDetail(root, { fetch: f, location: { search: '' } });
  assert.ok(els.body.textContent.includes('찾을 수 없습니다'));
  assert.equal(f.calls.filter((c) => c.url.indexOf('/api/hospital/facility') >= 0).length, 0);
});

test('상세 컨트롤러: from 파라미터는 q/sido/sigungu/page 만 통과시킨다', async () => {
  const { doc, root, els } = makeDetailRoot();
  const UI = loadUI(doc);
  const f = fakeFetch([
    ['/api/flags', mkRes(200, { hospital_module: true })],
    ['/api/hospital/facility', mkRes(200, { facility: { id: 'H-1', name: 'x', address: 'a' } })],
  ]);
  await UI.initDetail(root, { fetch: f, location: { search: '?id=H-1&from=' + encodeURIComponent('q=a&evil=<script>&page=3&redirect=http://x') } });
  const back = els.body.querySelectorAll('A').find((a) => (a.getAttribute('href') || '').indexOf('hospital.html') === 0);
  const bsp = new URLSearchParams(back.getAttribute('href').split('?')[1]);
  assert.deepEqual([...new Set([...bsp.keys()])].sort(), ['page', 'q']);
  assert.equal(bsp.get('q'), 'a');
});

/* ---------------- HTML 구조 / LTC 회귀 ---------------- */
test('HTML: hospital.html · hospital-facility.html 구조', () => {
  const h = read('hospital.html');
  assert.ok(h.includes('id="hospital-search"'));
  assert.ok(h.includes('data-h="prep"') && h.includes('data-h="search"'));
  assert.ok(h.includes('assets/js/hospital.js'));
  assert.ok(h.includes('aria-live="polite"'));
  assert.ok(h.includes('<label for="h-q"'));
  assert.ok(h.includes('noindex'));
  assert.equal(/onerror=|onclick=|onload=/.test(h), false);
  const d = read('hospital-facility.html');
  assert.ok(d.includes('id="hospital-detail"'));
  assert.ok(d.includes('data-h="body"'));
  assert.ok(d.includes('assets/js/hospital.js'));
});

test('LTC 회귀: 기존 화면·스크립트가 요양병원 코드를 참조하지 않는다', () => {
  for (const f of ['index.html', 'search.html', 'facility.html', 'assets/js/app.js', 'assets/js/data.js', 'assets/js/regioncodes.js']) {
    const src = read(f);
    assert.equal(/hospital\.js|hospital\.html|hospital-facility|\/api\/hospital\//.test(src), false, `${f} 가 요양병원 코드 참조`);
  }
  // 공통 함수는 그대로
  assert.ok(read('assets/js/app.js').includes('function mountChrome'));
  assert.ok(read('assets/js/data.js').includes('function ymd'));
  // style.css 는 무변경 — hospital.css 는 별도 파일
  assert.equal(/요양병원|hospital/i.test(read('assets/css/style.css')), false);
});

test('메뉴·홈 링크에 요양병원 항목을 추가하지 않았다 (Production 노출 금지)', () => {
  assert.equal(read('assets/js/app.js').includes('hospital.html'), false);
  assert.equal(read('index.html').includes('hospital.html'), false);
});

/* ================= 1B-4D PR 전 최종 통합점검 ================= */

// 1. 검색엔진 차단
test('통합: 두 페이지 모두 robots noindex,nofollow', () => {
  for (const f of ['hospital.html', 'hospital-facility.html']) {
    const h = read(f);
    assert.match(h, /<meta\s+name="robots"\s+content="noindex,\s*nofollow">/i, `${f} robots meta`);
  }
});

// 2. /api/flags 실패도 fail-closed — 모든 경우 병원 API 호출 0
test('통합: checkHospitalFlag 는 모든 실패 경우에 false + 화면은 준비 중', async () => {
  const cases = [
    ['flag=false', () => mkRes(200, { hospital_module: false })],
    ['network throw', () => { throw new Error('net'); }],
    ['non-200 (JSON body)', () => mkRes(500, { hospital_module: true })],
    ['non-200 (503)', () => mkRes(503, { error: 'x' })],
    ['JSON 파싱 실패', () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } })],
    ['hospital_module 키 없음', () => mkRes(200, { other: 1 })],
    ['"true" 문자열', () => mkRes(200, { hospital_module: 'true' })],
    ['1 숫자', () => mkRes(200, { hospital_module: 1 })],
    ['null', () => mkRes(200, { hospital_module: null })],
    ['본문 없음', () => mkRes(200, null)],
  ];
  for (const [label, handler] of cases) {
    const UI = loadUI();
    // 단위: checkHospitalFlag 직접
    // eslint-disable-next-line no-await-in-loop
    const on = await UI.checkHospitalFlag(async () => handler());
    assert.equal(on, false, `checkHospitalFlag ${label} → false 여야 함`);

    // 통합: initSearch 가 병원 API 를 부르지 않고 준비 중 화면
    const { doc, root, els } = makeSearchRoot();
    els.prep.textContent = '현재 준비 중인 서비스입니다.'; // 실제 HTML 이 제공하는 안내
    const UI2 = loadUI(doc);
    const f = async (url) => {
      if (String(url).indexOf('/api/flags') >= 0) return handler();
      throw new Error('unexpected fetch: ' + url); // 병원 API 를 부르면 테스트 실패
    };
    f.calls = [];
    // eslint-disable-next-line no-await-in-loop
    await UI2.initSearch(root, { fetch: f, history: { replaceState() {} }, location: { search: '', pathname: 'hospital.html' } });
    assert.equal(els.prep.hidden, false, `${label} → 준비 중 표시`);
    assert.equal(els.search.hidden, true, `${label} → 검색 UI 숨김`);
    assert.equal(els.list.textContent, '', `${label} → 목록 안 그림`);
    // 상태 영역에 내부 오류 흔적 없음
    assert.equal(/Error|SyntaxError|stack|http:|api\/|supabase/i.test(els.status.textContent), false, `${label} 내부오류 노출`);
  }
});

test('통합: hospital.html · hospital-facility.html 준비 중 안내 문구가 HTML 에 있다', () => {
  for (const f of ['hospital.html', 'hospital-facility.html']) {
    const h = read(f);
    const m = h.match(/data-h="prep"[\s\S]*?<\/section>/);
    assert.ok(m && /준비 중/.test(m[0]), `${f} prep 안내 문구`);
  }
});

test('통합: fetchImpl 없음/비함수여도 동기 throw 없이 false', async () => {
  const UI = loadUI();
  assert.equal(await UI.checkHospitalFlag(undefined), false);
  assert.equal(await UI.checkHospitalFlag(null), false);
  assert.equal(await UI.checkHospitalFlag(123), false);
});

test('통합: 상세도 flag 실패 시 병원 API 호출 0', async () => {
  for (const handler of [() => { throw new Error('x'); }, () => mkRes(502, {}), () => mkRes(200, { hospital_module: 'true' })]) {
    const { doc, root, els } = makeDetailRoot();
    const UI = loadUI(doc);
    const f = async (url) => {
      if (String(url).indexOf('/api/flags') >= 0) return handler();
      throw new Error('unexpected: ' + url);
    };
    // eslint-disable-next-line no-await-in-loop
    await UI.initDetail(root, { fetch: f, location: { search: '?id=H-1' } });
    assert.equal(els.prep.hidden, false);
    assert.equal(els.body.hidden, true);
  }
});

// 3. app.js 재사용 side effect
test('통합: app.js/data.js/regioncodes.js 는 fetch·XHR·전역 리스너·LTC API 를 실행하지 않는다 (정적)', () => {
  for (const f of ['assets/js/app.js', 'assets/js/data.js', 'assets/js/regioncodes.js']) {
    const src = read(f);
    const codeOnly = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.equal(/\bfetch\s*\(/.test(codeOnly), false, `${f} 에 fetch(`);
    assert.equal(/XMLHttpRequest/.test(codeOnly), false, `${f} 에 XHR`);
    assert.equal(/\.addEventListener\s*\(/.test(codeOnly), false, `${f} 에 addEventListener`);
    assert.equal(/DOMContentLoaded/.test(codeOnly), false, `${f} 에 DOMContentLoaded`);
    assert.equal(/['"`]\/api\//.test(codeOnly), false, `${f} 코드에 /api/ 경로`);
  }
});

test('통합: app.js 로드 + mountChrome("") 는 fetch 를 부르지 않고 hospital DOM 을 건드리지 않는다', () => {
  const APPJS = read('assets/js/app.js');
  // #chrome-header/#chrome-footer/#hospital-search 를 가진 문서 스텁
  const doc = makeDoc();
  const chromeH = doc.createElement('div'); chromeH.setAttribute('id', 'chrome-header');
  const chromeF = doc.createElement('div'); chromeF.setAttribute('id', 'chrome-footer');
  const hs = doc.createElement('main'); hs.setAttribute('id', 'hospital-search');
  hs.appendChild(doc.createElement('form'));
  const byId = { 'chrome-header': chromeH, 'chrome-footer': chromeF, 'hospital-search': hs };
  doc.getElementById = (id) => byId[id] || null;
  doc.querySelector = () => null; // nav.main 등 없음
  const body = doc.createElement('body');
  doc.body = body;

  let fetchCalls = 0;
  const sandbox = {
    window: {}, document: doc,
    localStorage: { getItem: () => null, setItem: () => {} },
    fetch: () => { fetchCalls += 1; return Promise.resolve(mkRes(200, {})); },
    console: { log() {}, warn() {}, error() {} },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(APPJS, sandbox, { filename: 'app.js' });

  const hsChildrenBefore = hs.children.length;
  assert.equal(typeof sandbox.mountChrome, 'function', 'mountChrome 전역 정의');
  sandbox.mountChrome(''); // hospital 페이지가 부르는 방식

  assert.equal(fetchCalls, 0, 'app.js 로드/mountChrome 이 fetch 호출');
  assert.equal(hs.children.length, hsChildrenBefore, 'mountChrome 이 #hospital-search 를 변경');
  assert.equal(hs.getAttribute('id'), 'hospital-search', '#hospital-search id 유지');
  assert.ok(chromeH.innerHTML && chromeH.innerHTML.length > 0, 'chrome-header 는 채워짐(정상 동작)');
});

// 4. Vercel 정적 routing + from 상한
test('통합: 정적 파일이 존재하고 vercel.json 이 /hospital*.html 를 가로채지 않는다', () => {
  assert.ok(read('hospital.html').length > 100);
  assert.ok(read('hospital-facility.html').length > 100);
  const v = JSON.parse(read('vercel.json'));
  // rewrites/redirects/routes 로 hospital 경로를 다른 곳으로 보내지 않음
  const json = JSON.stringify(v);
  assert.equal(/hospital/.test(json), false, 'vercel.json 이 hospital 경로 언급');
  for (const k of ['rewrites', 'redirects', 'routes']) {
    if (v[k]) {
      for (const rule of v[k]) {
        assert.equal(/hospital/.test(JSON.stringify(rule)), false, `vercel ${k} 규칙이 hospital 건드림`);
      }
    }
  }
});

test('통합: from 은 q/sido/sigungu/page 만 재구성, //evil·외부 URL 불가', async () => {
  const attacks = [
    'https://evil.com',
    '//evil.com',
    '/../../etc/passwd',
    'q=a&redirect=https://evil.com&next=//evil',
    'javascript:alert(1)',
    'q=' + 'x'.repeat(800) + '&page=1',          // from 전체가 상한 초과 → 통째로 무시
    'q=' + 'y'.repeat(200) + '&page=99999999',   // from 은 통과, 값은 클램프
  ];
  for (const bad of attacks) {
    const { doc, root, els } = makeDetailRoot();
    const UI = loadUI(doc);
    const f = fakeFetch([
      ['/api/flags', mkRes(200, { hospital_module: true })],
      ['/api/hospital/facility', mkRes(200, { facility: { id: 'H-1', name: 'x', address: 'a' } })],
    ]);
    // eslint-disable-next-line no-await-in-loop
    await UI.initDetail(root, { fetch: f, location: { search: '?id=H-1&from=' + encodeURIComponent(bad) } });
    const back = els.body.querySelectorAll('A').find((a) => (a.getAttribute('href') || '').indexOf('hospital.html') === 0);
    assert.ok(back, `back 링크 있음: ${bad.slice(0, 30)}`);
    const href = back.getAttribute('href');
    // 항상 hospital.html 로 시작하는 상대경로. 외부 스킴·// 로 시작 불가
    assert.match(href, /^hospital\.html(\?|$)/, `href 형식: ${href.slice(0, 60)}`);
    assert.equal(/^https?:|^\/\/|^javascript:|evil\.com/.test(href), false, `외부 이동 가능: ${href.slice(0, 60)}`);
    const bsp = new URLSearchParams((href.split('?')[1] || ''));
    for (const k of [...new Set([...bsp.keys()])]) {
      assert.ok(['q', 'sido', 'sigungu', 'page'].includes(k), `허용 안 된 from 키 "${k}"`);
    }
    // 상한: q ≤ 100, page ≤ 10000
    if (bsp.get('q')) assert.ok(bsp.get('q').length <= 100, 'from q 상한');
    if (bsp.get('page')) assert.ok(Number(bsp.get('page')) <= 10000, 'from page 상한');
  }
});

test('통합: 검색 상태 q/지역 길이·page 상한이 생성 URL 에 반영된다', async () => {
  const { doc, root, els } = makeSearchRoot();
  const UI = loadUI(doc);
  let seen = '';
  const f = fakeFetch([
    ['/api/flags', mkRes(200, { hospital_module: true })],
    ['/api/hospital/facilities', (url) => { seen = url; return mkRes(200, { items: [], page: 1, size: 20, total: 0 }); }],
  ]);
  const ready = {};
  await UI.initSearch(root, {
    fetch: f, history: { replaceState() {} },
    location: { search: '?q=' + 'z'.repeat(400) + '&sido=' + 's'.repeat(200) + '&page=999999999', pathname: 'hospital.html' },
    onReady: (api) => { ready.run = api.run; },
  });
  await new Promise((r) => setTimeout(r, 0));
  const sp = new URLSearchParams(seen.split('?')[1]);
  assert.ok(sp.get('q').length <= 100, 'q 100자 이하로 잘림: ' + sp.get('q').length);
  assert.ok(sp.get('sido').length <= 60, 'sido 60자 이하');
  assert.ok(Number(sp.get('page')) <= 10000, 'page 10000 이하: ' + sp.get('page'));
});
