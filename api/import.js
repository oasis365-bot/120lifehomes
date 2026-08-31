// GET /api/import — data/facilities_full.ndjson.gz 를 Supabase 로 upsert
//   공공데이터포털 「장기요양기관 시설별 현황」 + 「평가 결과」 가공본.
//   전국 주소·우편번호·시군구명·정원·평가등급, 광주·전남 포함.
//
//   ?offset=N&limit=1000   해당 구간만 처리 (기본 1000)
//   ?count=1               총 라인 수만 반환
//   보호: ?secret=$CRON_SECRET
import { haveDb, sb } from '../lib/db.js';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const config = { maxDuration: 60 };

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = join(HERE, '..', 'data', 'facilities_full.ndjson.gz');

let _lines = null;
function lines() {
  if (!_lines) {
    const raw = gunzipSync(readFileSync(FILE)).toString('utf8');
    _lines = raw.split('\n').filter(Boolean);
  }
  return _lines;
}

const SIDO_SHORT = {
  '서울특별시': '서울', '부산광역시': '부산', '대구광역시': '대구', '인천광역시': '인천',
  '광주광역시': '광주', '대전광역시': '대전', '울산광역시': '울산', '세종특별자치시': '세종',
  '경기도': '경기', '강원특별자치도': '강원', '강원도': '강원', '충청북도': '충북', '충청남도': '충남',
  '전북특별자치도': '전북', '전라북도': '전북', '전라남도': '전남', '경상북도': '경북', '경상남도': '경남',
  '제주특별자치도': '제주', '제주도': '제주',
};

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const ok = !secret || req.headers.authorization === `Bearer ${secret}` || (req.query && req.query.secret === secret);
  if (!ok) { res.status(401).json({ error: 'unauthorized' }); return; }
  if (!haveDb()) { res.status(503).json({ error: 'db_not_configured' }); return; }

  const all = lines();
  if (req.query && req.query.count) { res.status(200).json({ total: all.length, file: FILE }); return; }

  const offset = Math.max(parseInt(req.query?.offset, 10) || 0, 0);
  const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 1000, 1), 3000);
  const slice = all.slice(offset, offset + limit);
  if (!slice.length) { res.status(200).json({ ok: true, done: true, offset }); return; }

  const rows = [];
  for (const ln of slice) {
    let r;
    try { r = JSON.parse(ln); } catch { continue; }
    if (!r.id || !r.name) continue;
    const row = {
      id: r.id,
      name: r.name,
      sido: SIDO_SHORT[r.sido] || r.sido || null,
      sigungu_nm: r.sigungu_nm || null,
      dong_nm: r.dong_nm || null,
      address: r.address || null,
      post_no: r.post_no || null,
      established_at: r.established_at || null,
      updated_at: new Date().toISOString(),
    };
    if (r.type_code) row.type_code = r.type_code;
    if (r.type_label) row.type_label = r.type_label;
    if (r.capacity != null) row.capacity = r.capacity;
    if (r.eval_grade) row.eval_grade = r.eval_grade;
    if (r.eval_date) row.eval_date = r.eval_date;
    rows.push(row);
  }

  try {
    // 500개씩 나눠 upsert
    let upserted = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      await sb('facilities', {
        method: 'POST',
        body: chunk,
        prefer: 'resolution=merge-duplicates,return=minimal',
      });
      upserted += chunk.length;
    }
    res.status(200).json({
      ok: true, offset, limit, processed: slice.length, upserted,
      nextOffset: offset + limit, total: all.length,
    });
  } catch (e) {
    console.error('[import]', e.message);
    res.status(500).json({ error: 'import_failed', detail: String(e.message || e).slice(0, 400) });
  }
}
