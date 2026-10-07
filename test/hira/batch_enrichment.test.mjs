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
}] } = {}) {
  const calls = [];
  const sb = async (path, opt = {}) => {
    const method = (opt.method || 'GET').toUpperCase();
    calls.push({ path, method, body: structuredClone(opt.body) });
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
