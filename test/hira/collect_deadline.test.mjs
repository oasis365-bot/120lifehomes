// collect.js / client.js — wall-clock deadline budget (플랫폼 하드 타임아웃 전에 명확한 오류)
//
//  ⚠️ 이 파일의 시간 테스트는 "완전한 가상 시계"로 결정론화한다.
//     · now / sleep : fakeClock 주입 (실제 Date.now·setTimeout 안 씀)
//     · client backoff jitter : randomImpl 주입
//     · mock fetch : client 의 abort 타이머가 hung fetch 를 effTimeout 에서 끊는 것을
//                    모델링해 min(hangMs, effTimeout) 만큼만 가상 시계를 진전시킨다.
//       (실제로는 once() 의 setTimeout(abort, effTimeout) 이 그 역할을 함)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectHospitals } from '../../lib/hira/collect.js';
import { createHiraClient, HiraError } from '../../lib/hira/client.js';
import { makeMockClient } from './mockClient.mjs';

// 가짜 시계: sleep 과 mock HIRA 콜(tick)이 진전시킨다.
function fakeClock(start = 0) {
  let clock = start;
  return {
    now: () => clock,
    sleepImpl: async (ms) => { clock += Math.max(0, ms); },
    advance: (ms) => { clock += ms; },
    get value() { return clock; },
  };
}

// client.js 와 동일한 effTimeout 공식 (once() 참조): max(1000, min(7000, budget - 500))
const CLIENT_TIMEOUT_MS = 7000;
const CLIENT_PAD_MS = 500;
const effTimeout = (budget) =>
  Math.max(1000, Math.min(CLIENT_TIMEOUT_MS, budget - CLIENT_PAD_MS));

/**
 * "매달리는 fetch" 를 client 의 abort 계약에 맞게 모델링한 mock fetchImpl.
 *  · fetch 진입 시점의 남은 예산으로 effTimeout 을 계산.
 *  · min(hangMs, effTimeout) 만큼만 가상 시계 진전 후 AbortError throw
 *    (실 client 는 setTimeout(abort, effTimeout) 로 hung fetch 를 그 시점에 끊는다).
 */
function abortAwareFetch(ck, deadlineMs, hangMs = 6000) {
  return async () => {
    const budget = deadlineMs - ck.now();
    ck.advance(Math.min(hangMs, Math.max(0, effTimeout(budget))));
    const e = new Error('sim aborted'); e.name = 'AbortError'; throw e;
  };
}

test('collect: 상세 수집 중 예산 소진 → deadline_exceeded (부분 정규화로 성공 안 함)', async () => {
  const ck = fakeClock(0);
  const c = makeMockClient({ listTotal: 3, tick: () => ck.advance(5000) }); // 매 HIRA 콜 5s
  await assert.rejects(
    collectHospitals(c, {
      maxInstitutions: 3, pageSize: 100,
      now: ck.now, sleepImpl: ck.sleepImpl, deadlineMs: 30_000,
    }),
    (e) => e instanceof HiraError && e.reason === 'deadline_exceeded'
  );
  assert.ok(ck.value <= 30_000, `데드라인 초과: ${ck.value}`);
});

test('collect: semantic-empty 재시도가 남은 예산 밖이면 새 fetch/backoff 시작 안 함', async () => {
  const ck = fakeClock(0);
  const c = makeMockClient({ listTotal: 3, listEmptyFirst: 3, tick: () => ck.advance(3000) });
  await assert.rejects(
    collectHospitals(c, {
      maxInstitutions: 3, pageSize: 100, randomImpl: () => 0,
      now: ck.now, sleepImpl: ck.sleepImpl, deadlineMs: 12_000,
    }),
    (e) => e instanceof HiraError && e.reason === 'deadline_exceeded'
  );
  assert.ok(ck.value <= 12_000, `데드라인 초과: ${ck.value}`);
});

test('collect: 첫 콜조차 예산 밖이면 아무 fetch 도 안 하고 deadline_exceeded', async () => {
  const ck = fakeClock(0);
  const c = makeMockClient({ listTotal: 3, tick: () => ck.advance(5000) });
  await assert.rejects(
    collectHospitals(c, {
      maxInstitutions: 3, now: ck.now, sleepImpl: ck.sleepImpl, deadlineMs: 3_000, // EST(8s) 보다 적음
    }),
    (e) => e.reason === 'deadline_exceeded'
  );
  assert.equal(ck.value, 0); // 콜 0회
  assert.equal(c.calls.length, 0);
});

test('collect: 정상(빠른 콜) 은 예산을 건드리지 않고 3건 완성', async () => {
  const ck = fakeClock(0);
  const c = makeMockClient({ listTotal: 3, tick: () => ck.advance(100) });
  const r = await collectHospitals(c, {
    maxInstitutions: 3, now: ck.now, sleepImpl: ck.sleepImpl, deadlineMs: 30_000,
  });
  assert.equal(r.stats.normalized, 3);
  assert.ok(ck.value < 5_000);
});

// ── client.js 레벨 ──────────────────────────────────────────────────
test('client: 남은 예산 소진 시 새 시도·backoff 시작 안 함 → HiraError(deadline)', async () => {
  const START = 1_000_000;
  const BUDGET = 14_000;
  const ck = fakeClock(START);
  const deadlineMs = START + BUDGET;
  const calls = [];
  const inner = abortAwareFetch(ck, deadlineMs); // 6s 매달림 → abort 로 effTimeout 만큼만 소모
  const ff = async (url) => { calls.push(url); return inner(); };
  const c = createHiraClient({
    key: 'k', fetchImpl: ff, sleepImpl: ck.sleepImpl, now: ck.now,
    randomImpl: () => 0, // 결정론적 backoff
    minIntervalMs: 0, maxRetries: 5, deadlineMs,
  });
  await assert.rejects(() => c.listHospitals(), (e) =>
    e instanceof HiraError && ['deadline', 'timeout'].includes(e.reason));
  assert.ok(ck.value <= deadlineMs, `overshoot ${ck.value - START} (예산 ${BUDGET})`);
  assert.ok(calls.length <= 3, `호출 ${calls.length}회`);
});

test('client 데드라인: 실제 Math.random jitter 로 200회 반복해도 예산 초과 없음 (원래 flaky 케이스)', async () => {
  const START = 1_000_000;
  const BUDGET = 14_000; // run 34432150044 에서 overshoot 18857 로 실패했던 조건
  const deadlineMs = START + BUDGET;
  for (let i = 0; i < 200; i++) {
    const ck = fakeClock(START);
    const calls = [];
    const inner = abortAwareFetch(ck, deadlineMs);
    const c = createHiraClient({
      key: 'k', fetchImpl: async (u) => { calls.push(u); return inner(); },
      sleepImpl: ck.sleepImpl, now: ck.now, minIntervalMs: 0, maxRetries: 5, deadlineMs,
      // randomImpl 주입 안 함 → 실제 Math.random 사용 (원래 flaky 의 근원)
    });
    // eslint-disable-next-line no-await-in-loop
    await c.listHospitals().catch(() => {});
    assert.ok(
      ck.value <= deadlineMs,
      `iter ${i}: overshoot ${ck.value - START} (calls ${calls.length})`,
    );
  }
});

test('client 데드라인: jitter 전 구간에서 절대 예산 초과 없음 (경계·결정론)', async () => {
  const START = 1_000_000;
  for (const BUDGET of [3_000, 9_000, 14_000, 20_000, 45_000]) {
    for (const jitter of [0, 0.001, 0.25, 0.5, 0.75, 0.999]) {
      const ck = fakeClock(START);
      const deadlineMs = START + BUDGET;
      const calls = [];
      const inner = abortAwareFetch(ck, deadlineMs);
      const ff = async (u) => { calls.push(u); return inner(); };
      const c = createHiraClient({
        key: 'k', fetchImpl: ff, sleepImpl: ck.sleepImpl, now: ck.now,
        randomImpl: () => jitter, minIntervalMs: 0, maxRetries: 8, deadlineMs,
      });
      // eslint-disable-next-line no-await-in-loop
      await c.listHospitals().catch(() => {});
      assert.ok(
        ck.value <= deadlineMs,
        `BUDGET=${BUDGET} jitter=${jitter}: overshoot ${ck.value - START}, calls=${calls.length}`,
      );
    }
  }
});

test('client 데드라인: backoff 판단과 실제 sleep 이 같은 jitter 값을 쓴다 (불일치 없음)', async () => {
  const START = 0;
  const BUDGET = 50_000; // 넉넉 → deadline 아님, backoff 정상 수행
  const ck = fakeClock(START);
  const sleeps = [];
  const sleepImpl = async (ms) => { sleeps.push(ms); ck.advance(Math.max(0, ms)); };
  let n = 0;
  const ff = async () => {
    n += 1;
    ck.advance(10);
    if (n <= 2) return { status: 503, text: async () => 'e' }; // 2회 5xx → 2회 backoff
    return { status: 200, text: async () => '{"response":{"header":{"resultCode":"00"},"body":{"items":[],"totalCount":0}}}' };
  };
  const jitter = 0.5; // Math.floor(0.5*300)=150
  const c = createHiraClient({
    key: 'k', fetchImpl: ff, sleepImpl, now: ck.now,
    randomImpl: () => jitter, minIntervalMs: 0, maxRetries: 5, deadlineMs: START + BUDGET,
  });
  await c.listHospitals().catch(() => {});
  // backoff(1)=250+150=400, backoff(2)=500+150=650 — 판단·sleep 동일값
  assert.deepEqual(sleeps, [400, 650]);
});

test('client: 데드라인 없으면 기존 동작 그대로 (3회 재시도 후 throw)', async () => {
  const ff = async () => { const e = new Error('t'); e.name = 'AbortError'; throw e; };
  ff.calls = [];
  const waits = [];
  const c = createHiraClient({
    key: 'k', fetchImpl: ff, sleepImpl: async (ms) => { waits.push(ms); }, minIntervalMs: 0, maxRetries: 3,
  });
  await assert.rejects(() => c.listHospitals(), (e) => e instanceof HiraError && e.reason === 'timeout' && e.attempts === 3);
  assert.equal(waits.length, 2); // 2회 backoff
});

test('client: 모든 backoff sleep 은 전체 예산 이하 (예산 밖 sleep 시작 안 함)', async () => {
  const ck = fakeClock(0);
  const sleeps = [];
  const sleepImpl = async (ms) => { sleeps.push(ms); ck.advance(Math.max(0, ms)); };
  const ff = async () => { ck.advance(1000); return { status: 503, text: async () => 'e' }; }; // 계속 5xx
  const BUDGET = 9_000;
  const c = createHiraClient({
    key: 'k', fetchImpl: ff, sleepImpl, now: ck.now,
    randomImpl: () => 0, minIntervalMs: 0, maxRetries: 10, deadlineMs: BUDGET,
  });
  await c.listHospitals().catch(() => {});
  for (const s of sleeps) assert.ok(s <= BUDGET, `backoff ${s} > 예산 ${BUDGET}`);
  assert.ok(ck.value <= BUDGET + 1000, `overshoot ${ck.value}`); // 최대 1콜 초과
});
