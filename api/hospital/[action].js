// Vercel Hobby의 Serverless Function 12개 제한을 지키면서 기존 공개 경로
// /api/hospital/ingest 및 /api/hospital/batch를 그대로 유지하는 단일 라우터.
import ingestHandler from '../../lib/api/hospital_ingest.js';
import batchHandler from '../../lib/api/hospital_batch.js';

export const config = { maxDuration: 60 };

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
