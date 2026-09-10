// 인메모리 PostgREST 흉내 — persist.js 테스트용. 실제 DB 없음.
//
//  지원: GET(?col=eq.val, ?col=is.null, select 무시, limit, order=col.dir(다중키), prefer:count=exact)
//        POST(body 배열, on_conflict=merge-duplicates, prefer:return=representation, 유니크 위반 → 409 throw)
//        PATCH(body 객체, 필터 매칭 행 병합)

const UNIQUE = {
  facilities: (r) => `id:${r.id}`,
  hospital_profiles: (r) => `fid:${r.facility_id}`,
  facility_sources: (r) => `src:${r.source_system}|${r.external_id}`,
  facility_evaluations: (r) =>
    `ev:${r.facility_id}|${r.evaluation_authority}|${r.evaluation_name}|${r.evaluation_year ?? '__NULL__'}`,
};
const IDENTITY = new Set(['facility_evaluations', 'facility_revisions', 'ingestion_runs']);

export function makeMockSb(seed = {}) {
  const tables = {
    facilities: [], hospital_profiles: [], facility_sources: [],
    facility_evaluations: [], facility_revisions: [], ingestion_runs: [],
    feature_flags: [{ key: 'hospital_module', enabled: false }],
    ...JSON.parse(JSON.stringify(seed)),
  };
  const calls = [];
  const seq = {};
  const race = new Set(); // table 이름 → 다음 POST 1회는 409 (경쟁 시뮬레이션)

  function nextId(t) {
    seq[t] = (seq[t] || 0) + 1;
    return seq[t];
  }

  function parse(path) {
    const [table, qs = ''] = path.split('?');
    const params = {};
    const filters = [];
    for (const part of qs.split('&').filter(Boolean)) {
      const eq = part.indexOf('=');
      const k = decodeURIComponent(part.slice(0, eq));
      const v = decodeURIComponent(part.slice(eq + 1));
      if (['select', 'limit', 'order', 'on_conflict'].includes(k)) params[k] = v;
      else {
        const dot = v.indexOf('.');
        filters.push({ col: k, op: v.slice(0, dot), val: v.slice(dot + 1) });
      }
    }
    return { table, params, filters };
  }

  function match(row, filters) {
    return filters.every((f) => {
      const cur = row[f.col];
      if (f.op === 'is') return f.val === 'null' ? cur === null || cur === undefined : String(cur) === f.val;
      if (f.op === 'eq') return String(cur) === f.val;
      return false;
    });
  }

  async function sb(path, opt = {}) {
    const method = (opt.method || 'GET').toUpperCase();
    const { table, params, filters } = parse(path);
    calls.push({ method, table, filters, body: opt.body, prefer: opt.prefer });
    if (!tables[table]) tables[table] = [];
    const rows = tables[table];

    if (method === 'GET') {
      let hit = rows.filter((r) => match(r, filters));
      const count = /count=exact/.test(opt.prefer || '') ? hit.length : null;
      // order=col.dir[.nullsfirst|.nullslast][,col2.dir...]  (PostgREST 흉내, 다중키)
      if (params.order) {
        const keys = params.order.split(',').map((seg) => {
          const [col, dir = 'asc'] = seg.split('.');
          return { col, desc: dir === 'desc' };
        });
        hit = [...hit].sort((a, b) => {
          for (const { col, desc } of keys) {
            const av = a[col]; const bv = b[col];
            if (av === bv) continue;
            if (av == null) return 1;
            if (bv == null) return -1;
            const cmp = av < bv ? -1 : 1;
            return desc ? -cmp : cmp;
          }
          return 0;
        });
      }
      if (params.limit != null) hit = hit.slice(0, parseInt(params.limit, 10));
      return { data: hit.map((r) => ({ ...r })), count };
    }

    if (method === 'POST') {
      const list = Array.isArray(opt.body) ? opt.body : [opt.body];
      const mergeDup = /merge-duplicates/.test(opt.prefer || '') || !!params.on_conflict;
      const out = [];
      for (const raw of list) {
        const rec = { ...raw };
        if (IDENTITY.has(table) && rec.id == null) rec.id = nextId(table);
        const keyFn = UNIQUE[table];
        const existing = keyFn ? rows.find((r) => keyFn(r) === keyFn(rec)) : null;

        if (race.has(table)) {
          race.delete(table);
          if (!existing) rows.push({ ...rec }); // 경쟁자가 먼저 넣은 것처럼
          throw new Error(`Supabase 409 ${table} :: duplicate key value violates unique constraint "uq_${table}"`);
        }

        if (existing) {
          if (mergeDup) {
            Object.assign(existing, rec);
            out.push({ ...existing });
          } else {
            throw new Error(`Supabase 409 ${table} :: duplicate key value violates unique constraint "uq_${table}" (23505)`);
          }
        } else {
          rows.push(rec);
          out.push({ ...rec });
        }
      }
      return { data: /return=representation/.test(opt.prefer || '') ? out : null, count: null };
    }

    if (method === 'PATCH') {
      const patch = opt.body || {};
      let n = 0;
      for (const r of rows) {
        if (match(r, filters)) {
          Object.assign(r, patch);
          n += 1;
        }
      }
      return { data: null, count: n };
    }

    throw new Error(`mockSb: 미지원 method ${method}`);
  }

  sb.tables = tables;
  sb.calls = calls;
  sb.injectRace = (t) => race.add(t);
  sb.countWrites = () =>
    calls.filter((c) => c.method === 'POST' || c.method === 'PATCH').length;
  return sb;
}
