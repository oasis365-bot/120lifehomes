// Vercel Hobby의 Serverless Function 12개 제한을 지키면서 기존 공개 경로
// /api/hospital/ingest 및 /api/hospital/batch를 그대로 유지하는 단일 라우터.
import ingestHandler from '../../lib/api/hospital_ingest.js';
import batchHandler from '../../lib/api/hospital_batch.js';

// batch 는 요청 1회에 enrichment 를 약 180초까지 이어서 처리한다(lib/api/hospital_batch.js).
// Hobby + Fluid Compute 의 기본·최대 300초에 맞춘다. ingest 는 자체 wall-clock 예산으로
// 먼저 끊기므로 이 값을 올려도 동작이 달라지지 않는다.
export const config = { maxDuration: 300 };

const HANDLERS = Object.freeze({
  ingest: ingestHandler,
  batch: batchHandler,
});

function routeAction(req) {
  try {
    const pathname = new URL(String(req.url || ''), 'https://router.invalid').pathname;
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length !== 3 || parts[0] !== 'api' || parts[1] !== 'hospital') return '';
    return decodeURIComponent(parts[2]);
  } catch {
    return '';
  }
}

export function createHandler(handlers = HANDLERS) {
  return async function handler(req, res) {
    const selected = handlers[routeAction(req)];
    if (!selected) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    return selected(req, res);
  };
}

export default createHandler();
