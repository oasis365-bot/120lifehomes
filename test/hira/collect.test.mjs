import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectHospitals, maskYkiho, MAX_INSTITUTIONS_HARD_CAP } from '../../lib/hira/collect.js';
import { makeMockClient } from './mockClient.mjs';

test('정상 수집 — 통계·정규화·평가', async () => {
  const c = makeMockClient({ listTotal: 5 });
  const r = await collectHospitals(c, { maxInstitutions: 5 });
  assert.equal(r.stats.deduped, 5);
  assert.equal(r.stats.normalized, 5);
  assert.equal(r.stats.withCoord, 5); // 픽스처 5건 모두 유효 좌표 (item4 는 문자열 경도지만 범위 내)
  assert.equal(r.stats.evalFound, 5);
  assert.equal(r.stats.detailComplete, 5);
  assert.equal(r.failures.length, 0);
  assert.equal(r.meta.dryRun, true);
  assert.equal(r.meta.listTotalCount, 5);
});

test('10. ykiho 중복 제거', async () => {
  const c = makeMockClient({ listTotal: 10, dupEvery: 3 }); // i=3,6,9 는 #0 중복
  const r = await collectHospitals(c, { maxInstitutions: 20, pageSize: 100 });
  assert.equal(r.stats.listed, 10);
  assert.equal(r.stats.deduped, 7); // 10 - 3 중복
  const ids = r._normalizedAll.map((x) => x.hospital.external_id);
  assert.equal(new Set(ids).size, ids.length);
});

test('maxInstitutions 상한 20 강제', async () => {
  const c = makeMockClient({ listTotal: 100 });
  const r = await collectHospitals(c, { maxInstitutions: 999 });
  assert.ok(r.stats.deduped <= MAX_INSTITUTIONS_HARD_CAP);
});

test('부분 실패 — 전체 중단 없음, failures 에 재처리 정보 기록', async () => {
  const c = makeMockClient({ listTotal: 3, failSteps: new Set(['equipment', 'evaluation']) });
  const r = await collectHospitals(c, { maxInstitutions: 3 });
  assert.equal(r.stats.normalized, 3); // 정규화는 계속됨
  assert.equal(r.stats.detailPartial, 3); // equipment 실패로 partial
  assert.equal(r.stats.evalMissing, 3);
  assert.ok(r.failures.length >= 6); // 3 x (equipment + evaluation)
  for (const f of r.failures) {
    assert.ok(f.ykiho.includes('…') || f.ykiho.includes('***')); // 마스킹됨
    assert.ok(['equipment', 'evaluation'].includes(f.step));
  }
});

test('빈 상세 응답 처리 (facility 0건)', async () => {
  const c = makeMockClient({ listTotal: 2, emptySteps: new Set(['facility']) });
  const r = await collectHospitals(c, { maxInstitutions: 2 });
  assert.equal(r.stats.normalized, 2);
  assert.equal(r._normalizedAll[0].hospital.bed_total, null);
});

test('목록 자체 실패 — 현재까지로 진행, 경고 기록', async () => {
  const c = makeMockClient({ listTotal: 5 });
  c.listHospitals = async () => {
    throw Object.assign(new Error('gateway down'), { reason: 'gateway' });
  };
  const r = await collectHospitals(c, { maxInstitutions: 5 });
  assert.equal(r.stats.deduped, 0);
  assert.ok(r.warnings.some((w) => /목록/.test(w)));
});

test('11. 샘플·failures 에 ykiho 원문이 노출되지 않음', async () => {
  const c = makeMockClient({ listTotal: 3, failSteps: new Set(['facility']) });
  const r = await collectHospitals(c, { maxInstitutions: 3 });
  const blob = JSON.stringify({ samples: r.samples, failures: r.failures, warnings: r.warnings });
  // 픽스처 ykiho 원문(base64 유사 40+자) 이 응답 노출 부분에 없어야 함
  assert.equal(/JDQ4[A-Za-z0-9+/]{20,}/.test(blob), false);
  for (const s of r.samples) {
    assert.ok(s.hospital.external_id.includes('…'));
    assert.ok(s.hospital.id.startsWith('H-'));
  }
});

test('maskYkiho', () => {
  assert.equal(maskYkiho('short'), '***(5)');
  assert.equal(maskYkiho('JDQ4MTYyMiM4MSMkMSMk'), 'JDQ4MT…(20)');
});

test('페이지네이션 — pageSize 넘으면 다음 페이지 요청', async () => {
  const c = makeMockClient({ listTotal: 15 });
  const r = await collectHospitals(c, { maxInstitutions: 15, pageSize: 5 });
  assert.equal(r.stats.deduped, 15);
  assert.ok(r.stats.listPages >= 3);
  assert.ok(c.calls.includes('list:p3'));
});
