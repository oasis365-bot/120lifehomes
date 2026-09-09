import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createHiraClient, HiraError, HIRA_ENDPOINTS,
  FAILURE_KINDS, coerceFailureKind, sanitizeAttemptSummary, elapsedBucket, classifyFetchFailure,
} from '../../lib/hira/client.js';
import * as RAW from './fixtures/raw.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const fx = (name) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

// 즉시 resolve 하는 sleep (테스트 가속) + 호출 관찰
function fakeSleep() {
  const waits = [];
  const fn = (ms) => {
    waits.push(ms);
    return Promise.resolve();
  };
  fn.waits = waits;
  return fn;
}

// 순차 응답 큐를 소비하는 fake fetch
function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (typeof next === 'function') return next(url, init);
    if (next && next.throw) throw Object.assign(new Error(next.throw), { name: next.name || 'Error' });
    return {
      status: next?.status ?? 200,
      text: async () => next?.text ?? '',
    };
  };
  fn.calls = calls;
  return fn;
}

test('키 미설정 → HiraError(config)', () => {
  assert.throws(() => createHiraClient({ key: '' }), (e) => e instanceof HiraError && e.reason === 'config');
});

test('serviceKey 는 URL 쿼리로만 들어가고 응답 스크럽됨', async () => {
  const KEY = 'SECRET_KEY_1234567890';
  const responses = [{ status: 200, text: fx('hospBasisList_one.json') }];
  const ff = fakeFetch(responses);
  const c = createHiraClient({ key: KEY, fetchImpl: ff, sleepImpl: fakeSleep(), minIntervalMs: 0 });
  await c.listHospitals({ numOfRows: 1 });
  assert.ok(ff.calls[0].url.includes('serviceKey='));
  assert.ok(ff.calls[0].url.includes(encodeURIComponent(KEY)));
  // 스크럽 함수가 키를 제거하는지
  assert.equal(c._scrub(`x ${KEY} y`), 'x ***REDACTED*** y');
});

test('4. code 12 → 재시도 후 성공', async () => {
  const responses = [
    { status: 200, text: RAW.JSON_GATEWAY_12 }, // 1차: 일시적 게이트웨이 오류
    { status: 200, text: RAW.JSON_GATEWAY_12 }, // 2차: 또 실패
    { status: 200, text: fx('hospBasisList_clCd28.json') }, // 3차: 성공
  ];
  const ff = fakeFetch(responses);
  const sleep = fakeSleep();
  const c = createHiraClient({ key: 'k', fetchImpl: ff, sleepImpl: sleep, minIntervalMs: 0, maxRetries: 3 });
  const r = await c.listHospitals();
  assert.equal(r.resultCode, '00');
  assert.equal(r.attempts, 3);
  assert.equal(ff.calls.length, 3);
  assert.ok(sleep.waits.length >= 2); // 2번 백오프
});

test('4b. timeout(abort) → 재시도 후 성공', async () => {
  let n = 0;
  const ff = async () => {
    n += 1;
    if (n === 1) {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    }
    return { status: 200, text: async () => fx('hospBasisList_one.json') };
  };
  ff.calls = [];
  const c = createHiraClient({ key: 'k', fetchImpl: ff, sleepImpl: fakeSleep(), minIntervalMs: 0 });
  const r = await c.listHospitals({ numOfRows: 1 });
  assert.equal(r.resultCode, '00');
  assert.equal(n, 2);
});

test('4c. HTTP 500 / 429 → 재시도', async () => {
  const responses = [
    { status: 500, text: 'err' },
    { status: 429, text: 'slow down' },
    { status: 200, text: fx('hospBasisList_one.json') },
  ];
  const ff = fakeFetch(responses);
  const c = createHiraClient({ key: 'k', fetchImpl: ff, sleepImpl: fakeSleep(), minIntervalMs: 0 });
  const r = await c.listHospitals({ numOfRows: 1 });
  assert.equal(r.resultCode, '00');
  assert.equal(ff.calls.length, 3);
});

test('5. 최대 재시도 후 중단 → HiraError', async () => {
  const responses = [
    { status: 200, text: RAW.JSON_GATEWAY_12 },
    { status: 200, text: RAW.JSON_GATEWAY_12 },
    { status: 200, text: RAW.JSON_GATEWAY_12 },
  ];
  const ff = fakeFetch(responses);
  const c = createHiraClient({ key: 'k', fetchImpl: ff, sleepImpl: fakeSleep(), minIntervalMs: 0, maxRetries: 3 });
  await assert.rejects(
    () => c.listHospitals(),
    (e) => e instanceof HiraError && e.reason === 'gateway' && e.attempts === 3 && e.lastResultCode === '12'
  );
  assert.equal(ff.calls.length, 3);
});

test('5b. 비일시적 서비스 오류(code 30)는 재시도 없이 즉시 반환', async () => {
  const ff = fakeFetch([{ status: 200, text: RAW.JSON_PARAM_ERROR }]);
  const c = createHiraClient({ key: 'k', fetchImpl: ff, sleepImpl: fakeSleep(), minIntervalMs: 0 });
  const r = await c.listHospitals();
  assert.equal(r.resultCode, '30');
  assert.equal(ff.calls.length, 1); // 재시도 안 함
});

test('5c. 일일한도(code 22)도 재시도 안 함', async () => {
  const ff = fakeFetch([{ status: 200, text: RAW.JSON_GATEWAY_22 }]);
  const c = createHiraClient({ key: 'k', fetchImpl: ff, sleepImpl: fakeSleep(), minIntervalMs: 0 });
  const r = await c.listHospitals();
  assert.equal(r.gatewayError, true);
  assert.equal(r.resultCode, '22');
  assert.equal(ff.calls.length, 1);
});

test('5d. code 99 / code 1 은 재시도 안 함 (보수적 분류)', async () => {
  for (const body of [RAW.JSON_GATEWAY_99, RAW.JSON_GATEWAY_1]) {
    const ff = fakeFetch([{ status: 200, text: body }]);
    const c = createHiraClient({ key: 'k', fetchImpl: ff, sleepImpl: fakeSleep(), minIntervalMs: 0 });
    const r = await c.listHospitals();
    assert.equal(r.gatewayError, true);
    assert.equal(ff.calls.length, 1); // 재시도 없음
  }
});

test('요청 간 최소 간격이 강제됨 (minIntervalMs)', async () => {
  let clock = 0;
  const now = () => clock;
  const sleep = (ms) => {
    clock += ms;
    return Promise.resolve();
  };
  const ff = fakeFetch([
    { status: 200, text: fx('hospBasisList_one.json') },
    { status: 200, text: fx('hospBasisList_one.json') },
  ]);
  const c = createHiraClient({ key: 'k', fetchImpl: ff, sleepImpl: sleep, now, minIntervalMs: 250 });
  await c.listHospitals({ numOfRows: 1 });
  const t1 = clock;
  await c.listHospitals({ numOfRows: 1 });
  assert.ok(clock - t1 >= 250, `두 번째 요청 전 최소 250ms 대기 (실제 ${clock - t1})`);
});

// ── 관측용 failureKind / attemptSummary / elapsedBucket (allowlist) ──────────

// undici 스타일: `TypeError: fetch failed` + e.cause.{code,message}
const undiciThrow = (code, msg = 'boom') => {
  const cause = Object.assign(new Error(msg), { code });
  return Object.assign(new TypeError('fetch failed'), { cause });
};
// throw 만 하는 fetch (원하는 횟수만큼)
function throwingFetch(errFactory, times = 99) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    if (calls.length <= times) throw errFactory(calls.length);
    return { status: 200, text: async () => '{"response":{"header":{"resultCode":"00"},"body":{"items":[],"totalCount":0}}}' };
  };
  fn.calls = calls;
  return fn;
}
const mkClient = (fetchImpl, extra = {}) =>
  createHiraClient({ key: 'k', fetchImpl, sleepImpl: fakeSleep(), minIntervalMs: 0, maxRetries: 3, ...extra });

const KIND_CASES = [
  ['dns', () => undiciThrow('ENOTFOUND')],
  ['dns', () => undiciThrow('EAI_AGAIN')],
  ['tls', () => undiciThrow('UNABLE_TO_VERIFY_LEAF_SIGNATURE')],
  ['tls', () => undiciThrow('CERT_HAS_EXPIRED')],
  ['tls', () => undiciThrow('ERR_TLS_CERT_ALTNAME_INVALID')],
  ['network', () => undiciThrow('ECONNRESET')],
  ['network', () => undiciThrow('ECONNREFUSED')],
  ['timeout', () => undiciThrow('UND_ERR_HEADERS_TIMEOUT')],
  ['timeout', () => undiciThrow('UND_ERR_CONNECT_TIMEOUT')],
  ['timeout', () => undiciThrow('ETIMEDOUT')],
  ['unknown', () => undiciThrow('ESOMETHINGWEIRD')],
  ['unknown', () => new Error('bare error, no code')],
];

for (const [kind, factory] of KIND_CASES) {
  test(`failureKind 매핑: ${kind} (${factory().cause?.code ?? 'no-code'})`, async () => {
    const ff = throwingFetch(factory);
    const c = mkClient(ff);
    await assert.rejects(
      () => c.listHospitals(),
      (e) => {
        assert.ok(e instanceof HiraError);
        assert.equal(e.failureKind, kind);
        assert.equal(e.attempts, 3);
        assert.deepEqual(e.attemptSummary, { [kind]: 3 });
        assert.ok(FAILURE_KINDS.includes(e.failureKind));
        assert.ok(e.elapsedBucket === null || ['lt_1s', '1s_5s', '5s_15s', '15s_30s', '30s_45s', 'gte_45s'].includes(e.elapsedBucket));
        // legacy reason 도 유지 (timeout → timeout, 나머지 network류 → network)
        assert.equal(e.reason, kind === 'timeout' ? 'timeout' : 'network');
        return true;
      }
    );
    assert.equal(ff.calls.length, 3);
  });
}

test('failureKind 매핑: 우리가 건 abort → timeout', async () => {
  const ff = throwingFetch(() => Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
  await assert.rejects(
    () => mkClient(ff).listHospitals(),
    (e) => e.failureKind === 'timeout' && e.reason === 'timeout' && e.attemptSummary.timeout === 3
  );
});

test('failureKind 매핑: HTTP 429 → http_429', async () => {
  const ff = fakeFetch([{ status: 429 }, { status: 429 }, { status: 429 }]);
  await assert.rejects(
    () => mkClient(ff).listHospitals(),
    (e) => e.failureKind === 'http_429' && e.reason === 'http' && e.lastStatus === 429 &&
      JSON.stringify(e.attemptSummary) === JSON.stringify({ http_429: 3 })
  );
});

test('failureKind 매핑: HTTP 5xx → http_5xx', async () => {
  const ff = fakeFetch([{ status: 503 }, { status: 502 }, { status: 500 }]);
  await assert.rejects(
    () => mkClient(ff).listHospitals(),
    (e) => e.failureKind === 'http_5xx' && e.reason === 'http' && e.attemptSummary.http_5xx === 3
  );
});

test('failureKind 매핑: 게이트웨이 code 12 → result_code_12', async () => {
  const ff = fakeFetch([
    { status: 200, text: RAW.JSON_GATEWAY_12 },
    { status: 200, text: RAW.JSON_GATEWAY_12 },
    { status: 200, text: RAW.JSON_GATEWAY_12 },
  ]);
  await assert.rejects(
    () => mkClient(ff).listHospitals(),
    (e) => e.failureKind === 'result_code_12' && e.reason === 'gateway' &&
      e.attemptSummary.result_code_12 === 3 && e.lastResultCode === '12'
  );
});

test('attemptSummary 는 종류별로 섞인 3회를 정확히 집계, lastKind 가 failureKind', async () => {
  let n = 0;
  const ff = async () => {
    n += 1;
    if (n === 1) return { status: 503, text: async () => 'err' };
    throw undiciThrow('ENOTFOUND');
  };
  ff.calls = [];
  await assert.rejects(
    () => mkClient(ff).listHospitals(),
    (e) => {
      assert.deepEqual(e.attemptSummary, { http_5xx: 1, dns: 2 });
      assert.equal(e.failureKind, 'dns'); // 마지막 시도 종류
      return true;
    }
  );
});

test('failureKind 매핑: wall-clock 데드라인 초과 → deadline', async () => {
  let clock = 0;
  const now = () => clock;
  const sleep = (ms) => { clock += ms; return Promise.resolve(); };
  // 첫 호출부터 데드라인이 이미 임박하도록
  const ff = throwingFetch(() => undiciThrow('ECONNRESET'));
  const c = createHiraClient({
    key: 'k', fetchImpl: ff, sleepImpl: sleep, now, minIntervalMs: 0, maxRetries: 3,
    deadlineMs: 100,
  });
  await assert.rejects(
    () => c.listHospitals(),
    (e) => e instanceof HiraError && e.failureKind === 'deadline' && e.reason === 'deadline'
  );
});

test('비밀정보 미노출: 오류 원인에 serviceKey·엔드포인트 호스트가 들어와도 HiraError 관측필드엔 없음', async () => {
  const KEY = 'SUPER_SECRET_SERVICE_KEY_ABCDEF0123456789';
  // cause.message 에 키와 호스트를 일부러 심는다 (실제 undici 는 안 그러지만 방어 검증)
  const leaky = () => undiciThrow(
    'ENOTFOUND',
    `getaddrinfo ENOTFOUND apis.data.go.kr — serviceKey=${KEY}`
  );
  const ff = throwingFetch(leaky);
  const c = createHiraClient({ key: KEY, fetchImpl: ff, sleepImpl: fakeSleep(), minIntervalMs: 0, maxRetries: 3 });
  let caught;
  try { await c.listHospitals(); } catch (e) { caught = e; }
  assert.ok(caught instanceof HiraError);
  const observed = JSON.stringify({
    reason: caught.reason,
    failureKind: caught.failureKind,
    attemptSummary: caught.attemptSummary,
    elapsedBucket: caught.elapsedBucket,
    attempts: caught.attempts,
    lastStatus: caught.lastStatus,
    lastResultCode: caught.lastResultCode,
    op: caught.op,
  });
  assert.ok(!observed.includes(KEY), 'attemptSummary/failureKind 등에 serviceKey 없음');
  assert.ok(!observed.includes('apis.data.go.kr'), '관측필드에 엔드포인트 호스트 없음');
  assert.ok(!observed.includes('getaddrinfo'), '관측필드에 원인 메시지 원문 없음');
  assert.equal(caught.failureKind, 'dns');
  assert.deepEqual(caught.attemptSummary, { dns: 3 });
  // op 는 오퍼레이션 이름(공개 상수)이라 허용
  assert.equal(caught.op, 'getHospBasisList');
});

test('helper: coerceFailureKind / sanitizeAttemptSummary / elapsedBucket', () => {
  assert.equal(coerceFailureKind('dns'), 'dns');
  assert.equal(coerceFailureKind('nonsense'), 'unknown');
  assert.equal(coerceFailureKind(undefined), 'unknown');

  // allowlist 밖 키·비정수·음수·주입 시도는 전부 탈락
  assert.deepEqual(
    sanitizeAttemptSummary({ dns: 2, timeout: 1, evil: 5, secret: 'x', http_5xx: 0, network: -1, __proto__: { a: 1 } }),
    { dns: 2, timeout: 1 }
  );
  assert.equal(sanitizeAttemptSummary(null), null);
  assert.equal(sanitizeAttemptSummary({ evil: 3 }), null);
  assert.equal(sanitizeAttemptSummary('serviceKey=...'), null);

  assert.equal(elapsedBucket(0), 'lt_1s');
  assert.equal(elapsedBucket(999), 'lt_1s');
  assert.equal(elapsedBucket(3000), '1s_5s');
  assert.equal(elapsedBucket(12000), '5s_15s');
  assert.equal(elapsedBucket(20000), '15s_30s');
  assert.equal(elapsedBucket(40000), '30s_45s');
  assert.equal(elapsedBucket(60000), 'gte_45s');
  assert.equal(elapsedBucket(-1), null);
  assert.equal(elapsedBucket(NaN), null);
});

test('helper: classifyFetchFailure 는 원인 코드만 보고 allowlist 로만 답한다', () => {
  assert.equal(classifyFetchFailure(undiciThrow('ENOTFOUND'), false), 'dns');
  assert.equal(classifyFetchFailure(undiciThrow('ECONNRESET'), false), 'network');
  assert.equal(classifyFetchFailure(undiciThrow('CERT_HAS_EXPIRED'), false), 'tls');
  assert.equal(classifyFetchFailure(undiciThrow('UND_ERR_BODY_TIMEOUT'), false), 'timeout');
  assert.equal(classifyFetchFailure(undiciThrow('WAT'), false), 'unknown');
  assert.equal(classifyFetchFailure(null, true), 'timeout'); // aborted flag 우선
  assert.equal(classifyFetchFailure(new Error('x'), false), 'unknown');
  // 반환값은 항상 allowlist 안
  for (const c of ['ENOTFOUND', 'ECONNRESET', 'CERT_X', 'ETIMEDOUT', 'ZZZ']) {
    assert.ok(FAILURE_KINDS.includes(classifyFetchFailure(undiciThrow(c), false)));
  }
});

test('엔드포인트는 1B-1 실측 현행판 (폐기판으로 fallback 하지 않음)', () => {
  assert.equal(HIRA_ENDPOINTS.hospBasis.base, 'https://apis.data.go.kr/B551182/hospInfoServicev2');
  assert.equal(HIRA_ENDPOINTS.hospBasis.op, 'getHospBasisList');
  assert.equal(HIRA_ENDPOINTS.hospAsm.op, 'getHospAsmInfo1');
  assert.equal(HIRA_ENDPOINTS.detail.base, 'https://apis.data.go.kr/B551182/MadmDtlInfoService2.8');
  assert.equal(HIRA_ENDPOINTS.detail.ops.facility, 'getEqpInfo2.8');
});
