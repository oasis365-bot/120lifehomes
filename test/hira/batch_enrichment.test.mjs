import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HiraError } from '../../lib/hira/client.js';
import { COLLECTION_JOB } from '../../lib/hira/batch_discovery.js';
import { runEnrichmentItem } from '../../lib/hira/batch_enrichment.js';

const NOW = Date.parse('2026-09-16T01:00:00.000Z');
const job = (extra = {}) => ({
  id: '11111111-1111-4111-8111-111111111111', job: COLLECTION_JOB,
  status: 'pending', phase: 'enrichment', created_at: '2026-09-15T00:00:00.000Z',
  updated_at: '2026-09-15T00:00:00.000Z', count_processed: 0, count_new: 0,
  count_updated: 0, count_unchanged: 0, count_partial: 0, count_failed: 0,
  count_dead_letter: 0, ...extra,
});
const item = (extra = {}) => ({
  id: '22222222-2222-4222-8222-222222222222', job_id: job().id,
  facility_id: 'H-TEST123', ordinal: 0, status: 'pending', attempt_count: 0, ...extra,
});

function makeDb({ jobs = [job()], items = [item()], sources = [{
  source_system: 'hira_hospital_discovery', external_id: 'TEST123', raw: { basis: { ykiho: 'TEST123', yadmNm: '테스트' } },
}], usage, usageFails = false } = {}) {
  const calls = [];
  const sb = async (path, opt = {}) => {
    const method = (opt.method || 'GET').toUpperCase();
    calls.push({ path, method, body: structuredClone(opt.body) });
    // 시작 전 잔여 호출 점검용: usage 가 undefined 면 오늘 행이 없는 것(사용량 0)으로 본다.
    if (path.startsWith('hospital_hira_daily_usage?')) {
      if (usageFails) throw new Error('usage_read_failed');
      return { data: usage === undefined ? [] : [{ reserved_calls: usage }] };
    }
    if (path.startsWith('rpc/hospital_collection_job_acquire_lease')) return { data: true };
    if (path.startsWith('rpc/hospital_collection_job_release_lease')) {
      Object.assign(jobs[0], { status: opt.body.p_next_status, lease_owner: null });
      return { data: true };
    }
    if (path.startsWith('rpc/hospital_hira_reserve_daily_calls')) return { data: true };
    if (path.startsWith('hospital_collection_jobs?job=')) return { data: jobs.filter((x) => ['pending', 'running', 'paused_for_today'].includes(x.status)).slice(0, 1) };
    if (path.startsWith('hospital_collection_items?job_id=')) {
      const statuses = path.match(/status=in\.\(([^)]*)\)/)?.[1]?.split(',');
      const rows = statuses ? items.filter((x) => statuses.includes(x.status)) : items;
      const limit = parseInt(path.match(/limit=(\d+)/)?.[1] || String(rows.length), 10);
      return { data: rows.slice(0, limit).map((x) => ({ ...x })) };
    }
    if (path.startsWith('facility_sources?source_system=')) {
      const external = decodeURIComponent(path.match(/external_id=eq\.([^&]+)/)?.[1] || '');
      return { data: sources.filter((x) => x.external_id === external).map((x) => ({ ...x })) };
    }
    if (path.startsWith('hospital_collection_items?id=') && method === 'PATCH') {
      const id = decodeURIComponent(path.match(/id=eq\.([^&]+)/)?.[1] || '');
      Object.assign(items.find((x) => x.id === id), opt.body);
      return { data: null };
    }
    if (path.startsWith('hospital_collection_jobs?id=') && method === 'PATCH') {
      Object.assign(jobs[0], opt.body);
      return { data: null };
    }
    throw new Error(`unexpected_db:${method}:${path}`);
  };
  return { sb, jobs, items, calls };
}

function deps(db, extra = {}) {
  return {
    sb: db.sb, key: 'test-key', uuid: () => 'owner', now: () => NOW,
    createClient: (opt) => ({ opt }),
    collect: async (client, opt) => {
      assert.equal(opt.seededInstitutions[0].ykiho, 'TEST123');
      assert.equal(client.opt.key, 'test-key');
      return { _normalizedAll: [{ id: 'H-TEST123' }] };
    },
    persist: async () => ({ status: 'ok', stats: { new: 1, updated: 0, unchanged: 0, partial: 0 } }),
    ...extra,
  };
}

test('snapshot source를 메모리에서만 복원해 항목 하나를 완료한다', async () => {
  const db = makeDb();
  const out = await runEnrichmentItem(deps(db));
  assert.deepEqual(out, { ok: true, status: 'item_complete', didWork: true, phase: 'enrichment' });
  assert.equal(db.items[0].status, 'completed');
  assert.equal(db.jobs[0].count_processed, 1);
  assert.equal(db.jobs[0].count_new, 1);
  assert.doesNotMatch(JSON.stringify(out), /TEST123|테스트|ykiho|raw/i);
});

test('source가 없으면 HIRA 호출 없이 retry_wait로 남긴다', async () => {
  const db = makeDb({ sources: [] });
  let madeClient = 0;
  const out = await runEnrichmentItem(deps(db, { createClient: () => { madeClient += 1; return {}; } }));
  assert.equal(out.status, 'item_retry');
  assert.equal(madeClient, 0);
  assert.equal(db.items[0].status, 'retry_wait');
  assert.equal(db.items[0].last_error_code, 'source_missing');
});

test('세 번째 실패는 dead_letter로 끝낸다', async () => {
  const db = makeDb({ items: [item({ attempt_count: 2 })] });
  await assert.rejects(() => runEnrichmentItem(deps(db, { collect: async () => { throw new Error('network detail'); } })), /network detail/);
  assert.equal(db.items[0].status, 'dead_letter');
  assert.equal(db.items[0].last_error_code, 'enrichment_failed');
  assert.equal(db.jobs[0].count_dead_letter, 1);
});

test('쿼터/429 오류는 당일 pause하고 dead_letter로 보내지 않는다', async () => {
  const db = makeDb();
  const out = await runEnrichmentItem(deps(db, {
    collect: async () => { throw new HiraError('quota', { failureKind: 'quota_exhausted' }); },
  }));
  assert.equal(out.status, 'paused_for_today');
  assert.equal(db.items[0].status, 'retry_wait');
  assert.equal(db.items[0].last_error_code, 'quota_exhausted');
  assert.equal(db.jobs[0].status, 'paused_for_today');
});

test('기관 처리 중 HIRA deadline(시간 초과)이면 dead_letter 가 아니라 retry_wait 로 되돌려 나중에 재시도한다', async () => {
  const db = makeDb();
  await assert.rejects(
    () => runEnrichmentItem(deps(db, {
      collect: async () => { throw new HiraError('deadline', { reason: 'deadline', failureKind: 'deadline' }); },
    })),
    /deadline/,
  );
  assert.equal(db.items[0].status, 'retry_wait');
  assert.equal(db.items[0].attempt_count, 1);
  assert.equal(db.items[0].last_error_code, 'deadline');
  assert.ok(Date.parse(db.items[0].next_retry_at) > NOW, '재시도 시각은 미래');
  assert.equal(db.jobs[0].count_dead_letter, 0);
  assert.equal(db.jobs[0].count_partial, 1);
  assert.equal(db.jobs[0].status, 'pending', '일일 한도 pause 가 아니라 일반 재시도');
});

test('일일 HIRA 호출 한도 보호 유지: 호출마다 예약 RPC 를 거치고, 기본 1000·절대 상한 2000', async () => {
  const capFor = async (extra) => {
    const db = makeDb();
    let reserve;
    await runEnrichmentItem(deps(db, {
      createClient: (opt) => { reserve = opt.beforeAttempt; return { opt }; },
      ...extra,
    }));
    await reserve();
    return db.calls.filter((c) => c.path.startsWith('rpc/hospital_hira_reserve_daily_calls')).at(-1).body;
  };
  assert.deepEqual(await capFor({}), { p_calls: 1, p_requested_cap: 1000 });
  assert.deepEqual(await capFor({ dailyCallCap: 999_999 }), { p_calls: 1, p_requested_cap: 2000 });
  assert.deepEqual(await capFor({ dailyCallCap: 600 }), { p_calls: 1, p_requested_cap: 600 });
});

// ── 일일 한도·429 감지(수정): collect.js 는 단계별 오류를 삼키므로, 클라이언트 메서드가
//    한도성 오류로 거부되면 persist 전에 paused_for_today 로 멈춰야 한다. ──
const quotaErr = (failureKind = 'quota_exhausted') => new HiraError('quota', { reason: 'quota', failureKind });
// 실제 collect 처럼 단계 오류를 삼키고 "기본 정보만" 정규화한 결과를 돌려주는 목.
function swallowingCollect(callPlan) {
  return async (client) => {
    for (const method of callPlan) {
      try { await client[method](); } catch { /* collect.js 의 단계별 catch 와 같은 동작 */ }
    }
    return { _normalizedAll: [{ id: 'H-TEST123' }] };
  };
}
function plannedClient(failAt, kind = 'quota_exhausted') {
  let n = 0;
  const call = async () => { n += 1; if (n === failAt) throw quotaErr(kind); return { ok: true }; };
  return () => ({ getDetailInfo: call, getEquipment: call, getEvaluation: call });
}

for (const [label, kind, code] of [
  ['예약 거부(quota_exhausted)', 'quota_exhausted', 'quota_exhausted'],
  ['HTTP 429', 'http_429', 'hira_rate_limited'],
  ['upstream_quota', 'upstream_quota', 'hira_rate_limited'],
]) {
  test(`한도성 거부(${label})가 collect 에 삼켜져도 persist 전에 paused_for_today 로 멈춘다`, async () => {
    const db = makeDb({ items: [item({ attempt_count: 1 })] });
    let persisted = 0;
    const out = await runEnrichmentItem(deps(db, {
      createClient: plannedClient(1, kind),
      collect: swallowingCollect(['getDetailInfo', 'getEquipment', 'getEvaluation']),
      persist: async () => { persisted += 1; return { status: 'ok', stats: {} }; },
    }));
    assert.deepEqual(out, { ok: true, status: 'paused_for_today', didWork: false, phase: 'enrichment' });
    assert.equal(persisted, 0, 'persist 호출 0 — 기관 데이터를 한 줄도 쓰지 않음');
    assert.equal(db.items[0].status, 'retry_wait');
    assert.equal(db.items[0].last_error_code, code);
    assert.ok(Date.parse(db.items[0].next_retry_at) >= NOW + 23 * 3_600_000, '재시도는 약 24시간 뒤');
    assert.equal(db.items[0].attempt_count, 1, '한도로 멈춘 시도는 attempt_count 를 소모하지 않음');
    assert.equal(db.jobs[0].status, 'paused_for_today');
    assert.equal(db.jobs[0].count_dead_letter, 0);
  });
}

for (const [label, failAt] of [['기관 처리 중간(2번째 호출)', 2], ['마지막 평가(3번째) 호출만', 3]]) {
  test(`${label}에서 거부돼도 앞선 호출 결과를 저장하지 않고 일시 중지한다`, async () => {
    const db = makeDb();
    let persisted = 0;
    const out = await runEnrichmentItem(deps(db, {
      createClient: plannedClient(failAt),
      collect: swallowingCollect(['getDetailInfo', 'getEquipment', 'getEvaluation']),
      persist: async () => { persisted += 1; return { status: 'ok', stats: {} }; },
    }));
    assert.equal(out.status, 'paused_for_today');
    assert.equal(persisted, 0);
    assert.equal(db.items[0].attempt_count, 0);
    assert.equal(db.items[0].status, 'retry_wait');
  });
}

test('회귀: 한도와 무관한 단계 실패(HTTP 500)는 기존처럼 persist 되고 부분 저장 규칙을 따른다', async () => {
  const db = makeDb();
  let persisted = 0;
  const out = await runEnrichmentItem(deps(db, {
    createClient: plannedClient(2, 'http_5xx'),
    collect: swallowingCollect(['getDetailInfo', 'getEquipment', 'getEvaluation']),
    persist: async () => { persisted += 1; return { status: 'partial', stats: { partial: 0 } }; },
  }));
  assert.equal(persisted, 1);
  assert.equal(out.status, 'item_retry');
  assert.equal(db.items[0].attempt_count, 1, '일반 실패는 시도 횟수를 소모');
  assert.equal(db.jobs[0].status, 'pending');
});

test('회귀: 예약 DB 오류(quota_reservation_failed)는 한도 일시 중지로 취급하지 않는다', async () => {
  const db = makeDb();
  let persisted = 0;
  const out = await runEnrichmentItem(deps(db, {
    createClient: plannedClient(1, 'quota_reservation_failed'),
    collect: swallowingCollect(['getDetailInfo', 'getEquipment', 'getEvaluation']),
    persist: async () => { persisted += 1; return { status: 'partial', stats: {} }; },
  }));
  assert.equal(persisted, 1);
  assert.notEqual(out.status, 'paused_for_today');
});

test('시작 전 점검: 오늘 남은 호출이 7 미만이면 기관을 시작하지 않고 일시 중지한다(기관·시도 횟수 불변)', async () => {
  const db = makeDb({ usage: 994 }); // 기본 한도 1000 → 남은 6 < 7
  let clients = 0;
  let collected = 0;
  const out = await runEnrichmentItem(deps(db, {
    createClient: () => { clients += 1; return {}; },
    collect: async () => { collected += 1; return { _normalizedAll: [] }; },
  }));
  assert.deepEqual(out, { ok: true, status: 'paused_for_today', didWork: false, phase: 'enrichment' });
  assert.equal(clients, 0);
  assert.equal(collected, 0);
  assert.equal(db.items[0].status, 'pending');
  assert.equal(db.items[0].attempt_count, 0);
  assert.equal(db.jobs[0].status, 'paused_for_today');
  assert.equal(db.jobs[0].last_error_code, 'quota_exhausted');
  assert.equal(db.calls.some((c) => c.path.startsWith('rpc/hospital_hira_reserve_daily_calls')), false);
});

test('시작 전 점검: 남은 호출이 정확히 7이면 시작한다 / 요청 한도(dailyCallCap)를 따르고 절대 상한 2000 을 넘지 않는다', async () => {
  const ok = await runEnrichmentItem(deps(makeDb({ usage: 993 })));
  assert.equal(ok.status, 'item_complete', '1000-993=7 → 시작');

  const blocked = await runEnrichmentItem(deps(makeDb({ usage: 595 }), { dailyCallCap: 600 }));
  assert.equal(blocked.status, 'paused_for_today', '600-595=5 < 7');

  const capped = await runEnrichmentItem(deps(makeDb({ usage: 1996 }), { dailyCallCap: 999_999 }));
  assert.equal(capped.status, 'paused_for_today', '상한 2000-1996=4 < 7');
});

test('시작 전 점검: 사용량 행이 없거나(오늘 첫 호출) 읽기에 실패하면 막지 않고 진행한다', async () => {
  const none = await runEnrichmentItem(deps(makeDb()));
  assert.equal(none.status, 'item_complete');
  const failing = await runEnrichmentItem(deps(makeDb({ usageFails: true })));
  assert.equal(failing.status, 'item_complete', '읽기 실패는 막지 않음 — 한도는 호출마다 예약 RPC 가 강제');
});

test('시작 전 점검은 "남은 항목 없음" 마감을 막지 않는다(호출이 필요 없음)', async () => {
  const db = makeDb({ items: [], usage: 1000 });
  const out = await runEnrichmentItem(deps(db));
  assert.equal(out.status, 'enrichment_complete');
  assert.equal(db.jobs[0].status, 'completed');
});

test('한도로 멈춘 기관은 같은 날 다음 tick 에선 호출 0, 다음 KST 날짜에 같은 job 에서 먼저 재처리돼 완료된다', async () => {
  const db = makeDb();
  const first = await runEnrichmentItem(deps(db, {
    createClient: plannedClient(1),
    collect: swallowingCollect(['getDetailInfo']),
  }));
  assert.equal(first.status, 'paused_for_today');

  let clients = 0;
  const sameDay = await runEnrichmentItem(deps(db, { now: () => NOW + 3_600_000, createClient: () => { clients += 1; return {}; } }));
  assert.equal(sameDay.status, 'paused_for_today');
  assert.equal(clients, 0, '같은 날에는 HIRA 호출 0');

  const nextDay = await runEnrichmentItem(deps(db, { now: () => NOW + 25 * 3_600_000 }));
  assert.equal(nextDay.status, 'item_complete');
  assert.equal(db.items[0].status, 'completed');
  assert.equal(db.items[0].attempt_count, 1, '한도로 멈춘 시도는 세지 않으므로 완료 시점 시도는 1');
  assert.equal(db.jobs.length, 1);
});

test('강제종료 뒤 stale processing item은 lease 만료 뒤 재처리한다', async () => {
  const db = makeDb({ items: [item({ status: 'processing', attempt_count: 1, started_at: new Date(NOW - 91_000).toISOString() })] });
  const out = await runEnrichmentItem(deps(db));
  assert.equal(out.status, 'item_complete');
  assert.equal(db.items[0].attempt_count, 2);
});

test('남은 항목이 없으면 job을 done/completed로 마감한다', async () => {
  const db = makeDb({ items: [] });
  const out = await runEnrichmentItem(deps(db));
  assert.deepEqual(out, { ok: true, status: 'enrichment_complete', didWork: false, phase: 'done' });
  assert.equal(db.jobs[0].phase, 'done');
  assert.equal(db.jobs[0].status, 'completed');
});

test('모든 항목이 completed/dead_letter 로 끝났을 때만 job을 done/completed로 마감한다', async () => {
  const db = makeDb({ items: [
    item({ id: 'a', ordinal: 0, status: 'completed' }),
    item({ id: 'b', ordinal: 1, status: 'dead_letter' }),
  ] });
  const out = await runEnrichmentItem(deps(db));
  assert.deepEqual(out, { ok: true, status: 'enrichment_complete', didWork: false, phase: 'done' });
  assert.equal(db.jobs[0].phase, 'done');
  assert.equal(db.jobs[0].status, 'completed');
});

test('미래 시각의 retry_wait 만 남으면 job을 닫지 않고 retry_later, HIRA 호출 0건', async () => {
  const retryAtMs = NOW + 10 * 60_000;
  const db = makeDb({ items: [
    item({ id: 'a', ordinal: 0, status: 'completed' }),
    item({ id: 'b', ordinal: 1, status: 'retry_wait', attempt_count: 1, next_retry_at: new Date(retryAtMs).toISOString() }),
  ] });
  let madeClient = 0;
  let collected = 0;
  const out = await runEnrichmentItem(deps(db, {
    createClient: () => { madeClient += 1; return {}; },
    collect: async () => { collected += 1; return { _normalizedAll: [] }; },
  }));
  assert.deepEqual(out, { ok: true, status: 'retry_later', didWork: false, phase: 'enrichment' });
  assert.equal(madeClient, 0);
  assert.equal(collected, 0);
  assert.equal(db.calls.some((c) => c.path.startsWith('rpc/hospital_hira_reserve_daily_calls')), false);
  // job 은 닫히지 않고, 항목도 건드리지 않으며, lease 는 pending 으로 반납된다.
  assert.equal(db.jobs[0].phase, 'enrichment');
  assert.equal(db.jobs[0].status, 'pending');
  assert.equal(db.calls.some((c) => c.method === 'PATCH' && c.path.startsWith('hospital_collection_jobs?id=')), false);
  assert.equal(db.items[1].status, 'retry_wait');
  assert.equal(db.items[1].attempt_count, 1);
});

test('재시도 시각이 지나면 같은 job 에서 retry_wait 항목을 처리하고 그 뒤에 마감한다', async () => {
  const retryAtMs = NOW + 10 * 60_000;
  const db = makeDb({ items: [
    item({ id: 'b', ordinal: 0, status: 'retry_wait', attempt_count: 1, next_retry_at: new Date(retryAtMs).toISOString() }),
  ] });
  const jobId = db.jobs[0].id;
  assert.equal((await runEnrichmentItem(deps(db))).status, 'retry_later');

  // 시각이 retry 시각을 지난 뒤: 같은 job 이 그 항목을 처리한다(새 job 아님).
  const later = deps(db, { now: () => retryAtMs + 1 });
  const done = await runEnrichmentItem(later);
  assert.equal(done.status, 'item_complete');
  assert.equal(db.items[0].status, 'completed');
  assert.equal(db.items[0].attempt_count, 2);
  assert.equal(db.jobs.length, 1);
  assert.equal(db.jobs[0].id, jobId);
  assert.equal(db.jobs[0].count_processed, 1);

  // 모든 항목이 끝난 다음 tick 에서만 done/completed.
  const closed = await runEnrichmentItem(later);
  assert.equal(closed.status, 'enrichment_complete');
  assert.equal(db.jobs[0].phase, 'done');
  assert.equal(db.jobs[0].status, 'completed');
});

test('lease 가 아직 유효한 processing 항목만 남아도 job을 닫지 않는다', async () => {
  const db = makeDb({ items: [
    item({ status: 'processing', attempt_count: 1, started_at: new Date(NOW - 10_000).toISOString() }),
  ] });
  const out = await runEnrichmentItem(deps(db));
  assert.equal(out.status, 'retry_later');
  assert.equal(db.jobs[0].phase, 'enrichment');
  assert.equal(db.jobs[0].status, 'pending');
});
