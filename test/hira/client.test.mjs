import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHiraClient, HiraError, HIRA_ENDPOINTS } from '../../lib/hira/client.js';
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
    return { status: 200, text: fx('hospBasisList_one.json') };
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

test('엔드포인트는 1B-1 실측 현행판 (폐기판으로 fallback 하지 않음)', () => {
  assert.equal(HIRA_ENDPOINTS.hospBasis.base, 'https://apis.data.go.kr/B551182/hospInfoServicev2');
  assert.equal(HIRA_ENDPOINTS.hospBasis.op, 'getHospBasisList');
  assert.equal(HIRA_ENDPOINTS.hospAsm.op, 'getHospAsmInfo1');
  assert.equal(HIRA_ENDPOINTS.detail.base, 'https://apis.data.go.kr/B551182/MadmDtlInfoService2.8');
  assert.equal(HIRA_ENDPOINTS.detail.ops.facility, 'getEqpInfo2.8');
});
