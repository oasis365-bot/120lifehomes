// 기능 플래그 조회 — feature_flags 테이블 기반. 60초 인메모리 캐시.
//
//   getFlags() → { flags: {<key>: boolean}, schemaReady: boolean }
//     schemaReady = feature_flags 테이블이 존재하고 읽혔는가 (= migration 001 적용됨).
//       · 한 번이라도 true 였으면 이후 일시 오류에도 true 로 유지 (fail-safe).
//       · false 이면 호출부는 domain 컬럼을 참조하지 말 것 (마이그레이션 전 안전).
//
//   서버(Vercel 함수)에서만 import.
import { haveDb, sb } from './db.js';

const TTL_MS = 60_000;
let _cache = { at: 0, flags: {}, schemaReady: false };
let _schemaEverReady = false;

export async function getFlags() {
  const now = Date.now();
  if (now - _cache.at < TTL_MS && _cache.at !== 0) return _cache;

  if (!haveDb()) {
    _cache = { at: now, flags: {}, schemaReady: _schemaEverReady };
    return _cache;
  }

  try {
    const { data } = await sb('feature_flags?select=key,enabled');
    const flags = {};
    for (const r of Array.isArray(data) ? data : []) flags[r.key] = Boolean(r.enabled);
    _schemaEverReady = true;
    _cache = { at: now, flags, schemaReady: true };
  } catch (e) {
    // 테이블 없음(마이그레이션 전) 또는 일시 오류. 플래그는 전부 OFF 로 취급.
    _cache = { at: now, flags: {}, schemaReady: _schemaEverReady };
  }
  return _cache;
}

export function flagOn(flags, key) {
  return Boolean(flags && flags[key]);
}

// 테스트/운영 편의: 캐시 강제 무효화
export function _resetFlagCache() {
  _cache = { at: 0, flags: {}, schemaReady: false };
}
