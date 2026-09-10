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

test('full collect — 정규화 결과 필수필드(name) 누락 → normalizedAll 에서 제외, failures 기록', async () => {
  const c = makeMockClient({ listTotal: 3, dropNameAt: 1 }); // 2번째 기관 기관명 없음
  const r = await collectHospitals(c, { maxInstitutions: 3 });
  assert.equal(r.stats.deduped, 3);           // 목록에는 3건
  assert.equal(r.stats.normalized, 2);        // 저장 가능한 건 2건
  assert.equal(r._normalizedAll.length, 2);
  for (const it of r._normalizedAll) {
    assert.ok(it.hospital.id && it.hospital.external_id && it.hospital.name);
  }
  const req = r.failures.filter((f) => f.step === 'required_fields');
  assert.equal(req.length, 1);
  assert.equal(req[0].reason, 'missing');
  assert.ok(/name/.test(req[0].detail));
  assert.ok(req[0].ykiho.includes('…') || req[0].ykiho.includes('***')); // 마스킹
});

test('listOnly(readiness) — 필수필드 누락도 동일하게 제외', async () => {
  const c = makeMockClient({ listTotal: 3, dropNameAt: 0 });
  const r = await collectHospitals(c, { maxInstitutions: 3, listOnly: true });
  assert.equal(r.stats.normalized, 2);
  assert.equal(r._normalizedAll.length, 2);
  assert.equal(r.failures.filter((f) => f.step === 'required_fields').length, 1);
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

// ── source-aware 상태 (1B-4A) ───────────────────────────────────────
test('sources — 정상 수집이면 모든 상세 step 이 success_with_data', async () => {
  const c = makeMockClient({ listTotal: 2 });
  const r = await collectHospitals(c, { maxInstitutions: 2 });
  for (const it of r._normalizedAll) {
    assert.deepEqual(Object.keys(it.sources).sort(),
      ['departments', 'detail', 'equipment', 'facility', 'otherStaff', 'specialists']);
    for (const st of Object.values(it.sources)) assert.equal(st, 'success_with_data');
  }
});

test('sources — throw step=failed, 비정상 resultCode step=failed, 정상+0건 step=success_empty', async () => {
  const c = makeMockClient({
    listTotal: 1,
    failSteps: new Set(['equipment']),        // throw
    abnormalSteps: new Set(['departments']),  // gatewayError resultCode
    emptySteps: new Set(['otherStaff']),      // 정상 0건
  });
  const r = await collectHospitals(c, { maxInstitutions: 1 });
  const s = r._normalizedAll[0].sources;
  assert.equal(s.equipment, 'failed');
  assert.equal(s.departments, 'failed');
  assert.equal(s.otherStaff, 'success_empty');
  assert.equal(s.facility, 'success_with_data');
  assert.equal(s.detail, 'success_with_data');
  assert.equal(s.specialists, 'success_with_data');
});

test('sources — 응답·raw·samples 어디에도 sources 가 새 나가지 않음', async () => {
  const c = makeMockClient({ listTotal: 3, failSteps: new Set(['equipment']) });
  const r = await collectHospitals(c, { maxInstitutions: 3 });
  const { _normalizedAll, ...pub } = r;
  const blob = JSON.stringify(pub); // 응답으로 나가는 부분
  assert.equal(/success_with_data|success_empty|"sources"/.test(blob), false);
  for (const it of _normalizedAll) {
    assert.equal('sources' in it.raw, false, 'raw 에 sources 없음');
  }
  for (const s of r.samples) {
    assert.equal('sources' in s, false);
  }
});

test('normalized_hash — 동일 부분응답이면 동일 해시(멱등), 회복 수집이면 다른 해시', async () => {
  const partial = () => makeMockClient({ listTotal: 1, failSteps: new Set(['equipment']) });
  const full = () => makeMockClient({ listTotal: 1 });
  const h1 = (await collectHospitals(partial(), { maxInstitutions: 1 }))._normalizedAll[0].hospital.normalized_hash;
  const h2 = (await collectHospitals(partial(), { maxInstitutions: 1 }))._normalizedAll[0].hospital.normalized_hash;
  const h3 = (await collectHospitals(full(), { maxInstitutions: 1 }))._normalizedAll[0].hospital.normalized_hash;
  assert.equal(h1, h2, '동일 부분응답 → 동일 해시');
  assert.notEqual(h1, h3, '회복(정상) 수집 → 해시 변화');
  assert.match(h1, /^[0-9a-f]{64}$/);
});

test('normalized_hash — endpoint failed 와 success_empty 는 같은 필드값이어도 다른 해시', async () => {
  // equipment: throw(failed) vs 정상 0건(success_empty) → mapEquipment 결과는 둘 다 null(같은 필드값)
  const failed = makeMockClient({ listTotal: 1, failSteps: new Set(['equipment']) });
  const empty = makeMockClient({ listTotal: 1, emptySteps: new Set(['equipment']) });
  const hF = (await collectHospitals(failed, { maxInstitutions: 1 }))._normalizedAll[0].hospital.normalized_hash;
  const hE = (await collectHospitals(empty, { maxInstitutions: 1 }))._normalizedAll[0].hospital.normalized_hash;
  assert.notEqual(hF, hE, 'failed ≠ success_empty (삭제 skip 방지)');
});

test('빈 상세 응답 처리 (facility 0건)', async () => {
  const c = makeMockClient({ listTotal: 2, emptySteps: new Set(['facility']) });
  const r = await collectHospitals(c, { maxInstitutions: 2 });
  assert.equal(r.stats.normalized, 2);
  assert.equal(r._normalizedAll[0].hospital.bed_total, null);
});

test('목록 첫 페이지부터 실패 (수집 0건) — 빈 배열로 "성공" 반환 안 함, HiraError throw', async () => {
  const c = makeMockClient({ listTotal: 5 });
  c.listHospitals = async () => {
    throw Object.assign(new Error('gateway down'), { name: 'HiraError', reason: 'gateway' });
  };
  await assert.rejects(
    collectHospitals(c, { maxInstitutions: 5, sleepImpl: async () => {} }),
    (e) => e.name === 'HiraError' && e.reason === 'list_fetch_failed'
  );
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

// ── listOnly (readiness dry-run): 목록만, 상세·평가 미호출 ──
test('listOnly — 목록만 호출해 기본 정규화, 상세 6종·평가 API 호출 0', async () => {
  const c = makeMockClient({ listTotal: 3 });
  const r = await collectHospitals(c, { maxInstitutions: 3, pageSize: 100, listOnly: true });

  assert.equal(r.stats.deduped, 3);
  assert.equal(r.stats.normalized, 3);
  assert.equal(r.meta.mode, 'list_only');
  assert.equal(r._normalizedAll.length, 3);
  // 상세/평가 관련 통계·데이터 없음
  assert.equal(r.stats.detailComplete, 0);
  assert.equal(r.stats.detailPartial, 0);
  for (const it of r._normalizedAll) {
    assert.equal(it.evaluation, null);
    assert.deepEqual(Object.keys(it.raw), ['basis']); // raw 는 basis 만
    assert.ok(it.hospital.id.startsWith('H-'));
    assert.ok(it.hospital.external_id);
    assert.ok(it.hospital.name);
  }
  // client 호출은 목록뿐
  const detailCalls = c.calls.filter((x) =>
    ['facility', 'detail', 'departments', 'equipment', 'specialists', 'otherStaff', 'evaluation'].includes(x));
  assert.equal(detailCalls.length, 0);
  assert.equal(c.calls.filter((x) => x.startsWith('list:')).length, 1);
});

test('listOnly — ykiho 중복은 dedupe, 필수필드 없으면 정규화 제외', async () => {
  const c = makeMockClient({ listTotal: 6, dupEvery: 2 }); // i=2,4 중복 → 고유 4
  const r = await collectHospitals(c, { maxInstitutions: 10, pageSize: 100, listOnly: true });
  assert.equal(r.stats.listed, 6);
  assert.equal(r.stats.deduped, 4);
  assert.equal(r.stats.normalized, 4);
});
