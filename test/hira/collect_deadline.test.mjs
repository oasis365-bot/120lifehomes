// collect.js / client.js — wall-clock deadline budget (플랫폼 하드 타임아웃 전에 명확한 오류)
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
  // attempt1(+3s) → backoff+EST 가 남은 예산보다 크면 재시도 중단. 데드라인 넘지 않음.
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
  const ck = fakeClock(1_000_000);
  const calls = [];
  const ff = async (url) => {
    calls.push(url);
    ck.advance(6000); // 이 호출이 6s 매달렸다고 가정
    const e = new Error('sim timeout'); e.name = 'AbortError'; throw e;
  };
  const c = createHiraClient({
    key: 'k', fetchImpl: ff, sleepImpl: ck.sleepImpl, now: ck.now,
    minIntervalMs: 0, maxRetries: 5, deadlineMs: ck.now() + 14_000,
  });
  await assert.rejects(() => c.listHospitals(), (e) =>
    e instanceof HiraError && ['deadline', 'timeout'].includes(e.reason));
  assert.ok(ck.value - 1_000_000 <= 14_000, `overshoot ${ck.value - 1_000_000}`);
  assert.ok(calls.length <= 3, `호출 ${calls.length}회`);
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
    key: 'k', fetchImpl: ff, sleepImpl, now: ck.now, minIntervalMs: 0, maxRetries: 10, deadlineMs: BUDGET,
  });
  await c.listHospitals().catch(() => {});
  for (const s of sleeps) assert.ok(s <= BUDGET, `backoff ${s} > 예산 ${BUDGET}`);
  assert.ok(ck.value <= BUDGET + 1000, `overshoot ${ck.value}`); // 최대 1콜 초과
});
