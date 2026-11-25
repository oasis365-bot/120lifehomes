// 사이트 간 이동 링크(HOMES → 120 LIFE NEWS)와 회사 정보 정리의 정적 검사.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const pages = readdirSync(root).filter((f) => f.endsWith('.html'));

function renderChrome() {
  const els = {};
  const document = {
    body: { classList: { add() {}, remove() {} } },
    getElementById: (id) => (els[id] ||= { innerHTML: '' }),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const sandbox = {
    document, window: {}, localStorage: { getItem: () => null, setItem() {} },
    fetch: () => { throw new Error('no fetch'); }, console,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('assets/js/app.js'), sandbox);
  sandbox.mountChrome('');
  return { header: els['chrome-header'].innerHTML, footer: els['chrome-footer'].innerHTML };
}

test('메뉴(PC·모바일 공용 nav.main)와 푸터에 NEWS 링크가 하나씩 있다', () => {
  const { header, footer } = renderChrome();
  const nav = header.slice(header.indexOf('<nav class="main">'));
  const link = '<a href="https://120lifenews.co.kr/" rel="noopener">120 LIFE NEWS · 생활뉴스</a>';
  assert.equal(nav.split(link).length - 1, 1, '메뉴 링크 1개');
  assert.equal(footer.split(link).length - 1, 1, '푸터 링크 1개');
});

test('NEWS 링크에 추적 파라미터·새 창 강제·배너가 없다', () => {
  const src = read('assets/js/app.js');
  assert.ok(!/utm_|fbclid|gclid|ref=/.test(src), '추적 파라미터 없음');
  const { header, footer } = renderChrome();
  for (const html of [header, footer]) {
    const tags = html.match(/<a [^>]*120lifenews[^>]*>/g) || [];
    for (const t of tags) assert.ok(!/target=/.test(t), '새 창 강제 없음');
  }
});

test('임시 전화번호·자리표시 회사 정보가 남아 있지 않다', () => {
  const files = [...pages, 'assets/js/app.js', 'assets/js/data.js'];
  for (const f of files) {
    const s = read(f);
    assert.ok(!s.includes('1600-0000'), `${f}: 임시 전화번호`);
    for (const ph of ['[대표자명]', '[신고번호]', '[대표전화]']) {
      assert.ok(!s.includes(ph), `${f}: ${ph}`);
    }
  }
});

test('확정된 회사 정보만 표시한다(상호·사업자번호·대표·주소)', () => {
  const { footer } = renderChrome();
  for (const v of ['트로피컬리퍼블릭 주식회사', '120-87-70572', '대표 박강민', '테헤란로63길 12, B-322']) {
    assert.ok(footer.includes(v), v);
  }
  assert.ok(!footer.includes('통신판매업'), '미확인 신고번호 항목 없음');
});

test('요양병원 링크는 아직 메뉴에 없다(공개 승인 전)', () => {
  const { header } = renderChrome();
  assert.ok(!header.includes('hospital.html'));
});
