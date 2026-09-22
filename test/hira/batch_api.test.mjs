import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../../lib/api/hospital_batch.js';

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

test('빈 JSON object 또는 singleItemTest:true만 허용하고, 그 외 실행 파라미터 주입은 거부한다', async () => {
  for (const body of [
    null, [], 'x', { page: 9 }, { action: 'enrich' },
    { singleItemTest: false }, { singleItemTest: 'true' }, { singleItemTest: 1 },
    { singleItemTest: true, page: 1 }, { singleitemtest: true },
  ]) {
    const { out } = await invoke({ request: req({ body }) });
    assert.equal(out.code, 400, `거부돼야 함: ${JSON.stringify(body)}`);
    assert.deepEqual(out.payload, { error: 'invalid_body' });
  }
  // singleItemTest:true 하나만은 예외적으로 허용된다(아래 별도 테스트에서 효과까지 검증).
  const { out } = await invoke({ request: req({ body: { singleItemTest: true } }) });
  assert.equal(out.code, 200);
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

test('HIRA 일시 오류의 retry_later는 200과 안전한 집계만 반환한다', async () => {
  const { out } = await invoke({
    run: async () => ({ ok: true, status: 'retry_later', didWork: false, phase: 'discovery', error: 'hidden' }),
  });
  assert.equal(out.code, 200);
  assert.deepEqual(out.payload, { ok: true, status: 'retry_later', didWork: false, phase: 'discovery' });
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

test('discovery 완료 뒤에는 같은 안전한 실행 계약으로 enrichment로 들어간다 (item 1개, 이후 더 할 일 없음)', async () => {
  let enrichCalls = 0;
  const out = res();
  const h = createHandler({
    env: env(), sbImpl: async () => ({ data: [] }), assertDb: async () => ({ ok: true }),
    runDiscovery: async () => ({ ok: true, status: 'phase_complete', didWork: false, phase: 'enrichment' }),
    runEnrichment: async (arg) => {
      enrichCalls += 1;
      assert.equal(arg.key, 'test-hira-key');
      if (enrichCalls === 1) return { ok: true, status: 'item_complete', didWork: true, phase: 'enrichment', ykiho: 'never-return' };
      return { ok: true, status: 'enrichment_complete', didWork: false, phase: 'done' };
    },
    createClient: () => ({}), now: () => 1_000, uuid: () => 'owner',
  });
  await h(req(), out);
  // item 1개 처리 후, 다음 호출이 "더 할 일 없음"을 반환하면 즉시 멈춘다 — 2번만 불림.
  assert.equal(enrichCalls, 2);
  assert.deepEqual(out.payload, {
    ok: true, status: 'enrichment_complete', didWork: false, phase: 'done',
    attempted: 1, completed: 1, retried: 0, deadLettered: 0,
  });
});

test('enrichment 루프: item을 여러 개 이어서 처리하고(중복 없이 순차 실행) 완료/재시도/dead-letter를 집계한다', async () => {
  const outcomes = ['item_complete', 'item_retry', 'item_dead_letter', 'item_complete'];
  let calls = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  const out = res();
  const h = createHandler({
    env: env(), sbImpl: async () => ({ data: [] }), assertDb: async () => ({ ok: true }),
    runDiscovery: async () => ({ ok: true, status: 'phase_complete', didWork: false, phase: 'enrichment' }),
    runEnrichment: async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 0)); // 다른 마이크로태스크가 끼어들 여지를 줘서 동시성 위반이 있으면 드러나게 한다
      concurrent -= 1;
      const status = outcomes[calls] ?? 'enrichment_complete';
      calls += 1;
      if (status === 'enrichment_complete') return { ok: true, status, didWork: false, phase: 'done' };
      return { ok: true, status, didWork: true, phase: 'enrichment' };
    },
    createClient: () => ({}), now: () => 1_000, uuid: () => 'owner',
  });
  await h(req(), out);
  assert.equal(maxConcurrent, 1, 'item은 한 번에 하나씩만 처리해야 한다(동시 실행 금지 = 중복 처리 방지)');
  assert.equal(calls, outcomes.length + 1); // 4개 처리 + 마지막 "더 없음" 확인 1회
  assert.deepEqual(out.payload, {
    ok: true, status: 'enrichment_complete', didWork: false, phase: 'done',
    attempted: 4, completed: 2, retried: 1, deadLettered: 1,
  });
});

test('enrichment 루프: 일일 HIRA 호출 한도 도달(paused_for_today)이면 그 자리에서 즉시 멈춘다', async () => {
  let calls = 0;
  const out = res();
  const h = createHandler({
    env: env(), sbImpl: async () => ({ data: [] }), assertDb: async () => ({ ok: true }),
    runDiscovery: async () => ({ ok: true, status: 'phase_complete', didWork: false, phase: 'enrichment' }),
    runEnrichment: async () => {
      calls += 1;
      if (calls <= 2) return { ok: true, status: 'item_complete', didWork: true, phase: 'enrichment' };
      return { ok: true, status: 'paused_for_today', didWork: false, phase: 'enrichment' };
    },
    createClient: () => ({}), now: () => 1_000, uuid: () => 'owner',
  });
  await h(req(), out);
  assert.equal(calls, 3);
  assert.equal(out.payload.status, 'paused_for_today');
  assert.deepEqual(out.payload, {
    ok: true, status: 'paused_for_today', didWork: false, phase: 'enrichment',
    attempted: 2, completed: 2, retried: 0, deadLettered: 0,
  });
});

test('enrichment 루프: 다른 프로세스가 lease를 쥐고 있으면(busy) 즉시 멈추고 재요청은 안전하게 재개된다', async () => {
  let calls = 0;
  const out = res();
  const h = createHandler({
    env: env(), sbImpl: async () => ({ data: [] }), assertDb: async () => ({ ok: true }),
    runDiscovery: async () => ({ ok: true, status: 'phase_complete', didWork: false, phase: 'enrichment' }),
    runEnrichment: async () => { calls += 1; return { ok: true, status: 'busy', didWork: false, phase: 'enrichment' }; },
    createClient: () => ({}), now: () => 1_000, uuid: () => 'owner',
  });
  await h(req(), out);
  assert.equal(calls, 1);
  assert.deepEqual(out.payload, {
    ok: true, status: 'busy', didWork: false, phase: 'enrichment', attempted: 0, completed: 0, retried: 0, deadLettered: 0,
  });
});

test('enrichment 루프: 시간 예산(batchDeadlineMs)을 넘기면 item 처리 중이라도 다음 호출 전에 멈춘다', async () => {
  let calls = 0;
  let clock = 0;
  const out = res();
  const h = createHandler({
    env: env(), sbImpl: async () => ({ data: [] }), assertDb: async () => ({ ok: true }),
    runDiscovery: async () => ({ ok: true, status: 'phase_complete', didWork: false, phase: 'enrichment' }),
    runEnrichment: async () => {
      calls += 1;
      clock += 40; // item 하나 처리에 40ms 걸린다고 흉내
      return { ok: true, status: 'item_complete', didWork: true, phase: 'enrichment' };
    },
    createClient: () => ({}), now: () => clock, uuid: () => 'owner',
    enrichmentBatchDeadlineMs: 100, // 100ms 예산 → 40ms/item 이면 최대 2~3개만
  });
  await h(req(), out);
  assert.ok(calls >= 2 && calls <= 3, `시간 예산 안에서 멈춰야 함 (실제 ${calls}회)`);
  assert.equal(out.payload.attempted, calls);
});

test('enrichment 루프: item 수 안전 상한(batchMaxItems)을 넘기면 시간이 남아도 멈춘다', async () => {
  let calls = 0;
  const out = res();
  const h = createHandler({
    env: env(), sbImpl: async () => ({ data: [] }), assertDb: async () => ({ ok: true }),
    runDiscovery: async () => ({ ok: true, status: 'phase_complete', didWork: false, phase: 'enrichment' }),
    runEnrichment: async () => { calls += 1; return { ok: true, status: 'item_complete', didWork: true, phase: 'enrichment' }; },
    createClient: () => ({}), now: () => 1_000, uuid: () => 'owner',
    enrichmentBatchMaxItems: 5,
  });
  await h(req(), out);
  assert.equal(calls, 5);
  assert.equal(out.payload.attempted, 5);
});

test('singleItemTest:true — 시간이 남아도, 다른 batchMaxItems 설정이 더 높아도 정확히 1건에서 멈춘다(개수로 강제, 시간 추정 아님)', async () => {
  let calls = 0;
  const out = res();
  const h = createHandler({
    env: env(), sbImpl: async () => ({ data: [] }), assertDb: async () => ({ ok: true }),
    runDiscovery: async () => ({ ok: true, status: 'phase_complete', didWork: false, phase: 'enrichment' }),
    // 시간도, 기본 개수 상한도 넉넉히 줘도(고정 시계 + maxItems 200) 1건에서 멈춰야
    // singleItemTest가 시간이 아니라 개수 자체를 강제한다는 증거가 된다.
    runEnrichment: async () => { calls += 1; return { ok: true, status: 'item_complete', didWork: true, phase: 'enrichment' }; },
    createClient: () => ({}), now: () => 1_000, uuid: () => 'owner',
    enrichmentBatchDeadlineMs: 10_000_000, enrichmentBatchMaxItems: 200,
  });
  await h(req({ body: { singleItemTest: true } }), out);
  assert.equal(calls, 1, 'singleItemTest여도 여러 번 불리면 실제 데이터 처리 범위를 못 지킨 것');
  assert.deepEqual(out.payload, {
    ok: true, status: 'item_complete', didWork: true, phase: 'enrichment',
    attempted: 1, completed: 1, retried: 0, deadLettered: 0,
  });
});

test('singleItemTest:false(=일반 요청)는 기존처럼 여러 건을 이어서 처리한다(회귀 확인)', async () => {
  let calls = 0;
  const out = res();
  const h = createHandler({
    env: env(), sbImpl: async () => ({ data: [] }), assertDb: async () => ({ ok: true }),
    runDiscovery: async () => ({ ok: true, status: 'phase_complete', didWork: false, phase: 'enrichment' }),
    runEnrichment: async () => {
      calls += 1;
      if (calls <= 3) return { ok: true, status: 'item_complete', didWork: true, phase: 'enrichment' };
      return { ok: true, status: 'enrichment_complete', didWork: false, phase: 'done' };
    },
    createClient: () => ({}), now: () => 1_000, uuid: () => 'owner',
  });
  await h(req(), out); // body 없음 = 일반 요청
  assert.equal(calls, 4);
  assert.equal(out.payload.attempted, 3);
});

test('enrichment 루프 도중 예외가 나도 내부 메시지는 노출하지 않는다(기존 계약과 동일)', async () => {
  let calls = 0;
  const out2 = res();
  const h = createHandler({
    env: env(), sbImpl: async () => ({ data: [] }), assertDb: async () => ({ ok: true }),
    runDiscovery: async () => ({ ok: true, status: 'phase_complete', didWork: false, phase: 'enrichment' }),
    runEnrichment: async () => {
      calls += 1;
      if (calls === 1) return { ok: true, status: 'item_complete', didWork: true, phase: 'enrichment' };
      throw new Error('https://secret.supabase.co serviceKey=VERY_SECRET');
    },
    createClient: () => ({}), now: () => 1_000, uuid: () => 'owner',
  });
  await h(req(), out2);
  assert.equal(out2.code, 502);
  assert.deepEqual(out2.payload, { error: 'batch_failed' });
  assert.doesNotMatch(JSON.stringify(out2.payload), /secret|http|supabase|serviceKey/i);
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
  const src = await readFile(new URL('../../lib/api/hospital_batch.js', import.meta.url), 'utf8');
  const code = src.replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /req\.query|\?secret=|api\/hospital\/ingest/);
  assert.doesNotMatch(src, /api\/facilities|api\/ingest|api\/enrich/);
});
