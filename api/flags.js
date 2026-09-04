// GET /api/flags — 프런트가 참조하는 공개 기능 플래그 (읽기 전용, 비밀 아님)
//   응답: { hospital_module: false, ... }
//   마이그레이션 전이거나 오류 시: 전부 false.
import { getFlags } from '../lib/flags.js';

// 프런트에 노출을 허용하는 플래그 키만 화이트리스트
const PUBLIC_KEYS = ['hospital_module'];

export default async function handler(req, res) {
  const { flags } = await getFlags();
  const out = {};
  for (const k of PUBLIC_KEYS) out[k] = Boolean(flags[k]);
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
  res.status(200).json(out);
}
