// collect.js — "resultCode 정상 + (범위 내) 페이지 0건" 실측 간헐 장애의 bounded retry
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectHospitals } from '../../lib/hira/collect.js';
import { HiraError } from '../../lib/hira/client.js';
import { makeMockClient } from './mockClient.mjs';

// sleep/random 주입 — 실제 대기 없이 호출 인자만 기록
function harness() {
  const sleeps = [];
  const sleepImpl = async (ms) => { sleeps.push(ms); };
  const randomImpl = () => 0.5; // jitter 고정
  return { sleeps, sleepImpl, randomImpl };
}
const run = (client, extra = {}) => {
  const h = harness();
  return collectHospitals(client, { maxInstitutions: 3, pageSize: 100, sleepImpl: h.sleepImpl, randomImpl: h.randomImpl, ...extra })
    .then((r) => ({ r, sleeps: h.sleeps }))
    .catch((e) => ({ e, sleeps: h.sleeps }));
};

test('첫 요청 0건 → 두 번째 정상 3건 (retry 1회 후 성공)', async () => {
  const { r, sleeps } = await run(makeMockClient({ listTotal: 3, listEmptyFirst: 1 }));
  assert.equal(r.stats.deduped, 3);
  assert.equal(r.stats.normalized, 3);
  assert.equal(r.stats.listRetries, 1);
  assert.equal(sleeps.length, 1); // 재시도 전 1회 대기
  assert.ok(sleeps[0] >= 400 && sleeps[0] <= 400 + 250);
});

test('첫 두 번 0건 → 세 번째 정상 (retry 2회 후 성공)', async () => {
  const { r, sleeps } = await run(makeMockClient({ listTotal: 3, listEmptyFirst: 2 }));
  assert.equal(r.stats.deduped, 3);
  assert.equal(r.stats.listRetries, 2);
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps[1] > sleeps[0]); // 지수 백오프
});

test('세 번 모두 0건 → HiraError transient_empty_page_exhausted (성공 0건 반환 금지)', async () => {
  const { e, sleeps } = await run(makeMockClient({ listTotal: 3, listEmptyFirst: 3 }));
  assert.ok(e instanceof HiraError, `throw 안 함: ${e}`);
  assert.equal(e.reason, 'transient_empty_page_exhausted');
  assert.equal(e.attempts, 3);
  assert.equal(e.op, 'getHospBasisList');
  assert.equal(sleeps.length, 2); // 3회 시도 = 재시도 2회
  // 오류 메시지·필드에 URL/키/ykiho 없음
  const blob = JSON.stringify({ m: e.message, reason: e.reason, op: e.op, attempts: e.attempts, rc: e.lastResultCode });
  assert.equal(/https?:|serviceKey|apis\.data\.go\.kr|JDQ4/.test(blob), false);
});

test('totalCount>0 + items=0 (page inconsistency) → 재시도 대상', async () => {
  const { r } = await run(makeMockClient({ listTotal: 3, listEmptyFirst: 1, listEmptyTotal: 1280 }));
  assert.equal(r.stats.deduped, 3);
  assert.equal(r.stats.listRetries, 1);
});

test('totalCount 0/누락 + 첫 페이지 0건 → 여전히 재시도 대상 (이번 실측 근거)', async () => {
  const a = await run(makeMockClient({ listTotal: 3, listEmptyFirst: 1, listEmptyTotal: 0 }));
  assert.equal(a.r.stats.deduped, 3);
  assert.equal(a.r.stats.listRetries, 1);
  const b = await run(makeMockClient({ listTotal: 3, listEmptyFirst: 1, listEmptyTotal: null }));
  assert.equal(b.r.stats.deduped, 3);
  assert.equal(b.r.stats.listRetries, 1);
});

test('정상 마지막 페이지 종료 → 재시도 없음, 정상 완료', async () => {
  // listTotal 10, pageSize 5 → p1(5) p2(5) p3(빈, totalCount=10 → lastPage 2 → 정상 종료)
  const { r, sleeps } = await run(makeMockClient({ listTotal: 10 }), { maxInstitutions: 20, pageSize: 5 });
  assert.equal(r.stats.deduped, 10);
  assert.equal(r.stats.listRetries, 0);
  assert.equal(sleeps.length, 0);
  assert.equal(r.warnings.filter((w) => /transient/.test(w)).length, 0);
});

test('후속 페이지가 범위 내인데 0건 → 최대 3회 제한 재시도 후 성공', async () => {
  // p1 정상(5, totalCount 10) → meta.listTotalCount=10, lastPage=2
  // p2 첫 호출 0건(범위 내 → 비정상) → 재시도 → 정상(5)
  const { r } = await run(
    makeMockClient({ listTotal: 10, emptyOnPage: { 2: 1 } }),
    { maxInstitutions: 20, pageSize: 5 }
  );
  assert.equal(r.stats.deduped, 10);
  assert.equal(r.stats.listRetries, 1);
});

test('후속 페이지 3회 모두 0건(범위 내) → transient_empty_page_exhausted', async () => {
  const { e } = await run(
    makeMockClient({ listTotal: 10, emptyOnPage: { 2: 3 } }),
    { maxInstitutions: 20, pageSize: 5 }
  );
  assert.ok(e instanceof HiraError);
  assert.equal(e.reason, 'transient_empty_page_exhausted');
});

test('재시도 사이 대기: client 250ms 위에 지수 백오프+jitter (요청 간격 유지)', async () => {
  const { sleeps } = await run(makeMockClient({ listTotal: 3, listEmptyFirst: 2 }));
  // attempt2 backoff = min(4000, 400*2^0)=400 (+jitter 0.5*250=125) = 525
  // attempt3 backoff = min(4000, 400*2^1)=800 (+125) = 925
  assert.deepEqual(sleeps, [525, 925]);
});

// 재시도 계층 단일화: collect 는 client 가 throw 한 오류를 다시 재시도하지 않는다.
test('목록 throw → collect 재시도 없음 (단일 계층), 즉시 HiraError list_fetch_failed', async () => {
  const { e, sleeps } = await run(makeMockClient({ listTotal: 3, listThrowFirst: 1, listThrowReason: 'gateway' }));
  assert.ok(e instanceof HiraError, `throw 안 함: ${e}`);
  assert.equal(e.reason, 'list_fetch_failed');
  assert.equal(e.attempts, 1);            // collect 재시도 0 (client 내부 재시도는 client 몫)
  assert.equal(e.op, 'getHospBasisList');
  assert.equal(sleeps.length, 0);         // collect 레벨 backoff 없음
  const blob = JSON.stringify({ m: e.message, reason: e.reason, op: e.op });
  assert.equal(/https?:|serviceKey|apis\.data\.go\.kr|JDQ4/.test(blob), false);
});

test('목록 비정상 resultCode(code 1) → 재시도 없음 → HiraError list_abnormal_result', async () => {
  const { e, sleeps } = await run(makeMockClient({ listTotal: 3, listAbnormalFirst: 1, listAbnormalCode: '1' }));
  assert.ok(e instanceof HiraError, `throw 안 함: ${e}`);
  assert.equal(e.reason, 'list_abnormal_result');
  assert.equal(e.lastResultCode, '1');
  assert.equal(sleeps.length, 0);
});

test('목록 throw(client deadline reason) → deadline_exceeded 로 매핑', async () => {
  const { e } = await run(makeMockClient({ listTotal: 3, listThrowFirst: 1, listThrowReason: 'deadline' }));
  assert.ok(e instanceof HiraError);
  assert.equal(e.reason, 'deadline_exceeded');
});

test('list HTTP 호출은 최악에도 3회 이하 (3×3 중첩 없음)', async () => {
  // semantic-empty 3회 재시도 = list 3콜 (client 내부 재시도는 안 뜸 — 빠른 정상 응답이므로)
  const c = makeMockClient({ listTotal: 3, listEmptyFirst: 3 });
  await collectHospitals(c, { maxInstitutions: 3, sleepImpl: async () => {}, randomImpl: () => 0 }).catch(() => {});
  assert.equal(c.calls.filter((x) => x.startsWith('list:')).length, 3);
});

test('이미 일부 페이지 수집 후 후속 페이지가 계속 throw → 부분 결과 반환(throw 안 함), 경고', async () => {
  // p1 정상 5건(pageSize 5, totalCount 10) → 그 다음 호출부터 throw
  const { r } = await run(
    makeMockClient({ listTotal: 10, listThrowFrom: 2, listThrowReason: 'gateway' }),
    { maxInstitutions: 20, pageSize: 5 }
  );
  assert.equal(r.stats.deduped, 5); // p1 만
  assert.ok(r.warnings.some((w) => /목록 p2/.test(w)));
});

test('빈 응답 재시도가 endpoint fallback 을 하지 않는다 (listHospitals 만 호출)', async () => {
  const c = makeMockClient({ listTotal: 3, listEmptyFirst: 1 });
  await collectHospitals(c, { maxInstitutions: 3, pageSize: 100, sleepImpl: async () => {}, randomImpl: () => 0 });
  const listCalls = c.calls.filter((x) => x.startsWith('list:'));
  assert.equal(listCalls.length, 2); // 원 요청 + 재시도 1
  assert.ok(c.calls.every((x) => x.startsWith('list:') || ['facility', 'detail', 'departments', 'equipment', 'specialists', 'otherStaff', 'evaluation'].includes(x)));
});
