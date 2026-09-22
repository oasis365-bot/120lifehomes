// GitHub Actions 예약 실행에서 /api/hospital/batch 를 1회 호출하는 스크립트.
//
// 안전 설계:
//  · 한 번의 실행(node 프로세스)은 batch API를 정확히 1회만 호출한다. 재시도는
//    이 스크립트 안에서 하지 않고 다음 예약 tick 에 맡긴다 — job/item 상태는 DB에
//    원자적으로 저장되므로(lease + 일일 quota RPC), 이번 tick 이 실패·누락·지연돼도
//    다음 tick 이 그 상태 그대로 안전하게 이어받는다. 이 스크립트에서 멱등성을
//    새로 구현할 필요가 없다.
//  · 비밀값(CRON_SECRET, Vercel bypass)은 요청 헤더에만 실어 보내고, 어떤 경우에도
//    console.log/에러 메시지/GITHUB_STEP_SUMMARY 에 출력하지 않는다.
//  · 서버 쪽 배치 루프 시간 예산(45s)과 Vercel maxDuration(60s)보다 넉넉한 타임아웃을
//    둬서, 서버가 정상 범위 안에서 오래 걸려도 이 스크립트가 먼저 끊어버리지 않는다.
import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const REQUEST_TIMEOUT_MS = 90_000; // 서버 45s 예산 + Vercel maxDuration(60s) + 네트워크 여유

function readRequiredEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing_env:${name}`);
  return v;
}

/**
 * batch API를 정확히 1회 호출한다. 예외를 던지지 않고 항상 결과 객체를 반환한다
 * (호출자가 로그·종료코드를 일관되게 처리할 수 있도록).
 */
export async function runOnce({
  baseUrl = readRequiredEnv('HOSPITAL_BATCH_BASE_URL'),
  cronSecret = readRequiredEnv('HOSPITAL_BATCH_CRON_SECRET'),
  bypass = process.env.VERCEL_PROTECTION_BYPASS || '',
  fetchImpl = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  const headers = { Authorization: `Bearer ${cronSecret}`, 'Content-Type': 'application/json' };
  if (bypass) headers['x-vercel-protection-bypass'] = bypass;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}/api/hospital/batch`, {
      method: 'POST', headers, body: '{}', signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const reason = e?.name === 'AbortError' ? 'timeout' : 'network';
    return { ok: false, reason, httpStatus: null, body: null };
  }
  clearTimeout(timer);

  let body = null;
  try { body = await response.json(); } catch { /* 응답이 JSON이 아니면 body=null 유지 */ }
  // hospital_batch.js는 모든 응답(성공·오류 공통)을 이미 안전한 JSON({error:'...'} 포함)
  // 으로만 돌려주므로, body를 그대로 로그에 남겨도 비밀값·기관정보가 섞이지 않는다.
  return { ok: response.ok, httpStatus: response.status, body };
}

/** 로그 한 줄 + 종료코드 + (있으면) 요약 테이블 행을 만든다. */
export function summarize(result) {
  if (!result.ok && result.httpStatus === null) {
    const detail = result.errorMessage ? ` detail=${result.errorMessage}` : '';
    return {
      line: `enrichment batch tick failed before HTTP response: reason=${result.reason}${detail}`,
      exitCode: 1,
      summaryRow: null,
    };
  }
  if (!result.ok) {
    return {
      line: `enrichment batch tick failed: status=${result.httpStatus} body=${JSON.stringify(result.body)}`,
      exitCode: 1,
      summaryRow: null,
    };
  }
  const b = result.body;
  // HTTP 200이라도 응답 형태가 hospital_batch.js의 계약(ok:true + 문자열 status +
  // boolean didWork)과 다르면 성공으로 치지 않는다 — 잘못된 URL이 다른 서비스로
  // 연결되거나, 응답이 깨진 채 200을 반환하는 등의 설정 오류를 "성공"으로
  // 착각해 Actions가 초록불로 남는 사고를 막기 위함이다.
  if (!b || b.ok !== true || typeof b.status !== 'string' || !b.status || typeof b.didWork !== 'boolean') {
    return {
      line: `enrichment batch tick failed: unexpected response body on HTTP 200: ${JSON.stringify(b)}`,
      exitCode: 1,
      summaryRow: null,
    };
  }
  const safe = {
    status: b.status, phase: b.phase ?? null, didWork: b.didWork,
    attempted: b.attempted ?? 0, completed: b.completed ?? 0,
    retried: b.retried ?? 0, deadLettered: b.deadLettered ?? 0,
  };
  return {
    line: `enrichment batch tick ok: ${JSON.stringify(safe)}`,
    exitCode: 0,
    summaryRow: safe,
  };
}

async function writeStepSummary(summarized) {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (!target) return; // GitHub Actions 밖(로컬/테스트)에서는 조용히 건너뜀
  const row = summarized.summaryRow;
  // 실패 케이스는 summarized.line(콘솔에 남긴 것과 동일한 문구)을 그대로 적어,
  // 콘솔 로그와 Job Summary가 서로 다른 말을 하지 않게 한다.
  const md = row
    ? `### Enrichment batch tick\n\n` +
      `| status | phase | didWork | attempted | completed | retried | deadLettered |\n` +
      `|---|---|---|---|---|---|---|\n` +
      `| ${row.status} | ${row.phase} | ${row.didWork} | ${row.attempted} | ${row.completed} | ${row.retried} | ${row.deadLettered} |\n`
    : `### Enrichment batch tick — 실패\n\n${summarized.line}\n`;
  await appendFile(target, md);
}

export async function main() {
  let result;
  try {
    result = await runOnce();
  } catch (e) {
    // readRequiredEnv(HOSPITAL_BATCH_BASE_URL/HOSPITAL_BATCH_CRON_SECRET) 누락처럼
    // 네트워크 요청을 시작하기도 전에 실패하는 설정 오류. try/catch 없이 두면 Node가
    // 처리되지 않은 예외로 스크립트를 죽여 exitCode는 여전히 1이 되긴 하지만, 우리
    // 로그 형식·GITHUB_STEP_SUMMARY 기록을 건너뛰게 된다 — 여기서 잡아 같은 안전한
    // 경로로 보고한다. e.message는 이 스크립트 안에서 비밀값이 섞일 일이 없는
    // 제어된 문자열(예: "missing_env:HOSPITAL_BATCH_BASE_URL")만 담는다.
    result = { ok: false, httpStatus: null, reason: 'config', body: null, errorMessage: String(e?.message || e) };
  }
  const summarized = summarize(result);
  // eslint-disable-next-line no-console -- GitHub Actions 로그로 남기는 용도, 비밀값 없음
  console.log(summarized.line);
  await writeStepSummary(summarized);
  process.exitCode = summarized.exitCode;
}

const isDirectRun = (() => {
  try { return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href; } catch { return false; }
})();
if (isDirectRun) await main();
