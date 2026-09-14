import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../../api/hospital/batch.js';

const SECRET = 'test-batch-secret-123';
const env = (extra = {}) => ({
  VERCEL_ENV: 'preview', CRON_SECRET: SECRET, HOSPITAL_BATCH_ENABLED: '1',
  HOSPITAL_BATCH_DB_HOST: 'preview.example.invalid', SUPABASE_URL: 'https://preview.example.invalid',
  DATA_GO_KR_KEY: 'test-hira-key', ...extra,
});
const req = (extra = {}) => ({ method: 'POST', headers: { authorization: `Bearer ${SECRET}` }, body: {}, query: {}, ...extra });
function res() {
  return { code: null, payload: null, headers: {}, status(n) { this.code = n; return this; }, json(v) { this.payload = v; return this; }, setHeader(k, v) { this.headers[k] = v; } };
}
async function invoke({ request = req(), e = env(), assertDb = async () => ({ ok: true }), run, sbImpl } = {}) {
  const out = res();
  let runs = 0;
  const h = createHandler({
    env: e, assertDb, sbImpl: sbImpl || (async () => ({ data: [] })),
    run: run || (async () => { runs += 1; return { ok: true, status: 'page_complete', didWork: true, phase: 'discovery' }; }),
    createClient: () => ({}), now: () => 1_000, uuid: () => 'owner',
  });
  await h(request, out);
  return { out, runs };
}

test('Production은 잘못된 method/auth/body보다 먼저 404, 내부 호출 0', async () => {
  let guards = 0;
  const { out, runs } = await invoke({
    e: env({ VERCEL_ENV: 'production' }),
    request: req({ method: 'GET', headers: {}, body: 'bad' }),
    assertDb: async () => { guards += 1; return { ok: true }; },
  });
  assert.equal(out.code, 404);
  assert.deepEqual(out.payload, { error: 'not_found' });
  assert.equal(guards + runs, 0);
});

test('POST 외 메서드는 405 + Allow: POST', async () => {
  const { out } = await invoke({ request: req({ method: 'GET' }) });
  assert.equal(out.code, 405);
  assert.equal(out.headers.Allow, 'POST');
});

for (const authorization of ['', SECRET, 'Basic abc', 'Bearer wrong']) {
  test(`Bearer 전용 인증 거부: ${authorization || '(없음)'}`, async () => {
    const { out } = await invoke({ request: req({ headers: { authorization }, query: { secret: SECRET } }) });
    assert.equal(out.code, 401);
  });
}

test('빈 JSON object만 허용하고 실행 파라미터 주입을 거부한다', async () => {
  for (const body of [null, [], 'x', { page: 9 }, { action: 'enrich' }]) {
    const { out } = await invoke({ request: req({ body }) });
    assert.equal(out.code, 400);
    assert.deepEqual(out.payload, { error: 'invalid_body' });
  }
});

test('batch switch가 꺼져 있으면 DB/HIRA 호출 없이 501', async () => {
  let guards = 0;
  const { out, runs } = await invoke({
    e: env({ HOSPITAL_BATCH_ENABLED: '0' }),
    assertDb: async () => { guards += 1; return { ok: true }; },
  });
  assert.equal(out.code, 501);
  assert.equal(guards + runs, 0);
});

test('HIRA key가 없으면 DB/HIRA 호출 없이 503', async () => {
  let guards = 0;
  const { out, runs } = await invoke({
    e: env({ DATA_GO_KR_KEY: '' }), assertDb: async () => { guards += 1; return { ok: true }; },
  });
  assert.equal(out.code, 503);
  assert.equal(guards + runs, 0);
});

test('DB guard에는 batch 전용 exact host를 전달하고 실패 시 409', async () => {
  let got;
  const { out, runs } = await invoke({
    assertDb: async (x) => { got = x; return { ok: false, reason: 'db_has_ltc_rows' }; },
  });
  assert.equal(out.code, 409);
  assert.equal(out.payload.reason, 'db_has_ltc_rows');
  assert.equal(got.env.HOSPITAL_INGEST_DB_HOST, 'preview.example.invalid');
  assert.equal(runs, 0);
});

test('DB guard의 미등록 reason은 응답에서 unknown으로 축약한다', async () => {
  const { out } = await invoke({
    assertDb: async () => ({ ok: false, reason: 'https://secret.supabase.co/key' }),
  });
  assert.deepEqual(out.payload, { error: 'unsafe_db', reason: 'unknown' });
});

test('정상 요청은 안전한 batch 결과만 200으로 반환한다', async () => {
  let got;
  const { out } = await invoke({ run: async (x) => { got = x; return { ok: true, status: 'page_complete', didWork: true, phase: 'discovery', page: 1, added: 3 }; } });
  assert.equal(out.code, 200);
  assert.deepEqual(out.payload, { ok: true, status: 'page_complete', didWork: true, phase: 'discovery', page: 1, added: 3 });
  assert.equal(got.dailyCallCap, undefined);
  assert.equal(typeof got.sb, 'function');
  assert.equal(out.headers['Cache-Control'], 'no-store');
});

test('batch 결과도 whitelist로 재구성해 내부 필드를 버린다', async () => {
  const { out } = await invoke({
    run: async () => ({
      ok: true, status: 'page_complete', didWork: true, phase: 'discovery',
      page: 1, added: 2, ykiho: 'RAW', url: 'https://internal.invalid', secret: 'x',
    }),
  });
  assert.equal(out.code, 200);
  assert.doesNotMatch(JSON.stringify(out.payload), /RAW|internal|secret|ykiho|url/i);
});

test('내부 예외 메시지·URL·키는 응답에 노출하지 않는다', async () => {
  const { out } = await invoke({
    run: async () => { throw new Error('https://secret.supabase.co serviceKey=VERY_SECRET'); },
  });
  assert.equal(out.code, 502);
  assert.deepEqual(out.payload, { error: 'batch_failed' });
  assert.doesNotMatch(JSON.stringify(out.payload), /secret|http|supabase|serviceKey/i);
});

test('정적 계약: query 인증/제어 없음, 기존 3건 ingest와 LTC 파일을 import하지 않음', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../../api/hospital/batch.js', import.meta.url), 'utf8');
  const code = src.replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /req\.query|\?secret=|api\/hospital\/ingest/);
  assert.doesNotMatch(src, /api\/facilities|api\/ingest|api\/enrich/);
});
