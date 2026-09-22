import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOnce, summarize, main, isScheduleEnabled, REQUEST_TIMEOUT_MS } from '../../scripts/run_enrichment_batch.mjs';

const SECRET = 'super-secret-cron-value';
const BYPASS = 'super-secret-bypass-value';

function fakeFetch(handler) {
  return async (url, opt) => handler(url, opt);
}

test('runOnce: Bearer/bypass 헤더를 올바르게 싣고, baseUrl 끝 슬래시를 정리해 경로를 만든다', async () => {
  let seenUrl; let seenHeaders; let seenBody;
  const fetchImpl = fakeFetch(async (url, opt) => {
    seenUrl = url; seenHeaders = opt.headers; seenBody = opt.body;
    return { ok: true, status: 200, json: async () => ({ ok: true, status: 'item_complete', phase: 'enrichment', didWork: true, attempted: 1, completed: 1, retried: 0, deadLettered: 0 }) };
  });
  const result = await runOnce({
    baseUrl: 'https://preview.example.invalid/', cronSecret: SECRET, bypass: BYPASS, fetchImpl,
  });
  assert.equal(seenUrl, 'https://preview.example.invalid/api/hospital/batch');
  assert.equal(seenHeaders.Authorization, `Bearer ${SECRET}`);
  assert.equal(seenHeaders['x-vercel-protection-bypass'], BYPASS);
  assert.equal(seenBody, '{}');
  assert.equal(result.ok, true);
  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.attempted, 1);
});

test('runOnce: bypass 값이 없으면 그 헤더를 아예 보내지 않는다', async () => {
  let seenHeaders;
  const fetchImpl = fakeFetch(async (url, opt) => {
    seenHeaders = opt.headers;
    return { ok: true, status: 200, json: async () => ({ ok: true, status: 'busy', phase: 'enrichment', didWork: false }) };
  });
  await runOnce({ baseUrl: 'https://x.invalid', cronSecret: SECRET, bypass: '', fetchImpl });
  assert.equal('x-vercel-protection-bypass' in seenHeaders, false);
});

test('runOnce: 4xx/5xx 응답도 예외 없이 ok:false + httpStatus + body로 반환한다', async () => {
  const fetchImpl = fakeFetch(async () => ({ ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) }));
  const result = await runOnce({ baseUrl: 'https://x.invalid', cronSecret: 'wrong', fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.httpStatus, 401);
  assert.deepEqual(result.body, { error: 'unauthorized' });
});

test('runOnce: 네트워크 오류는 reason=network, httpStatus=null로 안전하게 반환한다(예외를 던지지 않음)', async () => {
  const fetchImpl = fakeFetch(async () => { throw new Error('ECONNRESET https://x.invalid?secret=leak'); });
  const result = await runOnce({ baseUrl: 'https://x.invalid', cronSecret: SECRET, fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'network');
  assert.equal(result.httpStatus, null);
});

test('runOnce: 응답이 지연되면 timeoutMs에서 중단하고 reason=timeout을 반환한다', async () => {
  const fetchImpl = fakeFetch(async (url, opt) => new Promise((resolve, reject) => {
    opt.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }));
  const result = await runOnce({ baseUrl: 'https://x.invalid', cronSecret: SECRET, fetchImpl, timeoutMs: 20 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timeout');
});

test('runOnce: 필수 값(baseUrl/cronSecret)이 없으면 네트워크 호출 전에 즉시 실패한다', async () => {
  delete process.env.HOSPITAL_BATCH_BASE_URL;
  delete process.env.HOSPITAL_BATCH_CRON_SECRET;
  let called = false;
  await assert.rejects(
    () => runOnce({ fetchImpl: fakeFetch(async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; }) }),
    /missing_env:HOSPITAL_BATCH_BASE_URL/,
  );
  assert.equal(called, false);
});

test('summarize: 성공 결과는 안전한 집계만 담고, 비밀값은 절대 포함하지 않는다', () => {
  const result = {
    ok: true, httpStatus: 200,
    body: { ok: true, status: 'item_complete', phase: 'enrichment', didWork: true, attempted: 3, completed: 2, retried: 1, deadLettered: 0, secret: SECRET },
  };
  const { line, exitCode, summaryRow } = summarize(result);
  assert.equal(exitCode, 0);
  assert.doesNotMatch(line, new RegExp(SECRET));
  assert.doesNotMatch(line, /secret/); // body에 실수로 섞여 들어온 비표준 필드도 summarize가 그대로 통과시키지 않는지 확인
  assert.deepEqual(summaryRow, { status: 'item_complete', phase: 'enrichment', didWork: true, attempted: 3, completed: 2, retried: 1, deadLettered: 0 });
});

test('summarize: HTTP 실패/네트워크 실패 모두 exitCode 1이고 summaryRow는 null이다', () => {
  const httpFail = summarize({ ok: false, httpStatus: 401, body: { error: 'unauthorized' } });
  assert.equal(httpFail.exitCode, 1);
  assert.equal(httpFail.summaryRow, null);

  const netFail = summarize({ ok: false, httpStatus: null, reason: 'timeout', body: null });
  assert.equal(netFail.exitCode, 1);
  assert.equal(netFail.summaryRow, null);
  assert.match(netFail.line, /timeout/);
});

for (const [name, body] of [
  ['빈 응답(null, 예: JSON 파싱 실패 시 runOnce가 만드는 값)', null],
  ['ok 필드 누락', { status: 'item_complete', didWork: true }],
  ['status가 문자열이 아님', { ok: true, status: 123, didWork: true }],
  ['status가 빈 문자열', { ok: true, status: '', didWork: true }],
  ['didWork가 boolean이 아님', { ok: true, status: 'item_complete', didWork: 'yes' }],
  ['완전히 다른 서비스의 JSON(엉뚱한 URL을 가리킬 때 재현 가능)', { message: 'Hello from a different app' }],
]) {
  test(`summarize: HTTP 200이라도 응답 형태가 계약과 다르면(${name}) 성공으로 치지 않는다`, () => {
    const out = summarize({ ok: true, httpStatus: 200, body });
    assert.equal(out.exitCode, 1, '설정 오류·엉뚱한 대상 URL을 "성공"으로 착각하면 안 됨');
    assert.equal(out.summaryRow, null);
    assert.match(out.line, /unexpected response body/);
  });
}

test('main(): 필수 환경변수가 없으면 예외로 죽지 않고, 실패로 안전하게 종료·기록한다(설정 오류가 초록불로 안 보이게)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'enrichment-batch-test-'));
  const summaryPath = join(dir, 'summary.md');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(summaryPath, '');

  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const logs = [];
  process.env.HOSPITAL_BATCH_SCHEDULE_ENABLED = '1'; // 이 테스트는 "스위치는 켜져 있는데 설정이 없는" 경우를 본다
  delete process.env.HOSPITAL_BATCH_BASE_URL;
  delete process.env.HOSPITAL_BATCH_CRON_SECRET;
  delete process.env.VERCEL_PROTECTION_BYPASS;
  process.env.GITHUB_STEP_SUMMARY = summaryPath;
  let fetchCalled = false;
  globalThis.fetch = async () => { fetchCalled = true; return { ok: true, status: 200, json: async () => ({}) }; };
  console.log = (...args) => logs.push(args.join(' '));
  try {
    await main();
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    delete process.env.HOSPITAL_BATCH_SCHEDULE_ENABLED;
    delete process.env.GITHUB_STEP_SUMMARY;
  }

  assert.equal(fetchCalled, false, '설정이 없으면 네트워크 호출 자체를 시도하면 안 됨');
  assert.equal(process.exitCode, 1);
  process.exitCode = 0; // 이 프로세스 안에서 다른 테스트에 영향 주지 않도록 리셋
  assert.match(logs.join('\n'), /missing_env:HOSPITAL_BATCH_BASE_URL/);
  const summaryContent = await readFile(summaryPath, 'utf8');
  assert.match(summaryContent, /실패/);
  assert.match(summaryContent, /missing_env/);

  await rm(dir, { recursive: true, force: true });
});

test('main(): GITHUB_STEP_SUMMARY 파일에 안전한 표만 적고, 콘솔 출력에도 비밀값이 없다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'enrichment-batch-test-'));
  const summaryPath = join(dir, 'summary.md');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(summaryPath, '');

  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const logs = [];
  process.env.HOSPITAL_BATCH_SCHEDULE_ENABLED = '1';
  process.env.HOSPITAL_BATCH_BASE_URL = 'https://x.invalid';
  process.env.HOSPITAL_BATCH_CRON_SECRET = SECRET;
  process.env.VERCEL_PROTECTION_BYPASS = BYPASS;
  process.env.GITHUB_STEP_SUMMARY = summaryPath;
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ ok: true, status: 'item_complete', phase: 'enrichment', didWork: true, attempted: 1, completed: 1, retried: 0, deadLettered: 0 }),
  });
  console.log = (...args) => logs.push(args.join(' '));
  try {
    await main();
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    delete process.env.HOSPITAL_BATCH_SCHEDULE_ENABLED;
    delete process.env.HOSPITAL_BATCH_BASE_URL;
    delete process.env.HOSPITAL_BATCH_CRON_SECRET;
    delete process.env.VERCEL_PROTECTION_BYPASS;
    delete process.env.GITHUB_STEP_SUMMARY;
  }

  assert.equal(process.exitCode, 0);
  process.exitCode = 0; // 이 프로세스 안에서 다른 테스트에 영향 주지 않도록 리셋
  const summaryContent = await readFile(summaryPath, 'utf8');
  assert.match(summaryContent, /attempted/);
  assert.doesNotMatch(summaryContent, new RegExp(SECRET));
  assert.doesNotMatch(summaryContent, new RegExp(BYPASS));
  assert.doesNotMatch(logs.join('\n'), new RegExp(SECRET));
  assert.doesNotMatch(logs.join('\n'), new RegExp(BYPASS));

  await rm(dir, { recursive: true, force: true });
});

for (const [name, value] of [
  ['설정 안 함(undefined)', undefined],
  ["'0'", '0'],
  ["'false'", 'false'],
  ["'true'(소문자 word는 안 됨)", 'true'],
  ["'True'(대소문자도 정확히 일치해야 함)", 'True'],
  ["빈 문자열", ''],
  ["숫자 1이 아닌 문자열 ' 1'(공백 포함)", ' 1'],
]) {
  test(`isScheduleEnabled: ${name}이면 꺼진 것으로 취급한다(기본값 OFF)`, () => {
    const env = value === undefined ? {} : { HOSPITAL_BATCH_SCHEDULE_ENABLED: value };
    assert.equal(isScheduleEnabled(env), false);
  });
}

test("isScheduleEnabled: 정확히 문자열 '1'일 때만 켜진 것으로 취급한다", () => {
  assert.equal(isScheduleEnabled({ HOSPITAL_BATCH_SCHEDULE_ENABLED: '1' }), true);
});

test('main(): 스위치가 꺼져 있으면(기본값) 다른 설정이 하나도 없어도 API를 호출하지 않고 종료코드 0으로 끝난다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'enrichment-batch-test-'));
  const summaryPath = join(dir, 'summary.md');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(summaryPath, '');

  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const logs = [];
  // 스위치를 켜는 값도, base URL/CRON_SECRET/bypass 도 전부 비워둔다 — main 병합
  // 직후(시크릿 등록 전)를 그대로 재현한다. 스위치 체크가 다른 어떤 설정보다도
  // 먼저 일어나야 이 상태에서도 안전하게 "스킵"으로 끝난다.
  delete process.env.HOSPITAL_BATCH_SCHEDULE_ENABLED;
  delete process.env.HOSPITAL_BATCH_BASE_URL;
  delete process.env.HOSPITAL_BATCH_CRON_SECRET;
  delete process.env.VERCEL_PROTECTION_BYPASS;
  process.env.GITHUB_STEP_SUMMARY = summaryPath;
  let fetchCalled = false;
  globalThis.fetch = async () => { fetchCalled = true; return { ok: true, status: 200, json: async () => ({}) }; };
  console.log = (...args) => logs.push(args.join(' '));
  try {
    await main();
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    delete process.env.GITHUB_STEP_SUMMARY;
  }

  assert.equal(fetchCalled, false, '스위치가 꺼져 있으면 어떤 상황에서도 API를 호출하면 안 됨');
  assert.equal(process.exitCode, 0, '스위치 OFF는 정상적인 상태이지 실패가 아님');
  process.exitCode = 0;
  assert.match(logs.join('\n'), /skipped/);
  assert.match(logs.join('\n'), /HOSPITAL_BATCH_SCHEDULE_ENABLED/);
  const summaryContent = await readFile(summaryPath, 'utf8');
  assert.match(summaryContent, /스킵됨/);

  await rm(dir, { recursive: true, force: true });
});

test("main(): 스위치가 '0'이어도(명시적으로 꺼둔 경우) API를 호출하지 않는다", async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  process.env.HOSPITAL_BATCH_SCHEDULE_ENABLED = '0';
  let fetchCalled = false;
  globalThis.fetch = async () => { fetchCalled = true; return { ok: true, status: 200, json: async () => ({}) }; };
  console.log = () => {};
  try {
    await main();
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    delete process.env.HOSPITAL_BATCH_SCHEDULE_ENABLED;
  }
  assert.equal(fetchCalled, false);
  assert.equal(process.exitCode, 0);
  process.exitCode = 0;
});

test('상수: 요청 타임아웃은 Vercel maxDuration(60s)보다 여유 있게 길다', () => {
  assert.ok(REQUEST_TIMEOUT_MS > 60_000, 'REQUEST_TIMEOUT_MS가 서버 maxDuration보다 짧으면 정상 처리 중에도 클라이언트가 먼저 끊어버릴 수 있음');
});
