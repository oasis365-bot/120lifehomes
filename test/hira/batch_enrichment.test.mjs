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
    if (path.startsWith('hospital_collection_items?job_id=')) return { data: items.map((x) => ({ ...x })) };
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
