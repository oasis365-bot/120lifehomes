// HIRA(공공데이터포털) 연결 점검 — 요청 1회에 한 번, 첫 기관을 부르기 전에 실행한다.
// ─────────────────────────────────────────────────────────────────────
//  TCP 연결과 TLS 인사만 하고 곧바로 끊는다. HTTP 요청을 보내지 않으므로 API 호출·
//  사용량·키와 무관하다. 시간 초과가 「연결 자체가 안 됨」인지 「연결됐으나 응답 없음」
//  인지 나눠 보기 위한 관측용이며, 결과는 아래 allowlist 문자열과 ms 정수만 내보낸다
//  (주소·IP·오류 원문 비노출). 점검이 실패해도 수집 흐름은 바꾸지 않는다.
// ─────────────────────────────────────────────────────────────────────
import tls from 'node:tls';

export const HIRA_PROBE_HOST = 'apis.data.go.kr';
export const PROBE_TIMEOUT_MS = 3000;
export const PROBE_RESULTS = Object.freeze([
  'ok', 'connect_timeout', 'tls_timeout', 'dns_error', 'connect_refused', 'connect_error', 'tls_error',
]);

function classify(err, stage) {
  const code = String((err && err.code) || '');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns_error';
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET') return 'connect_refused';
  return stage === 'tcp' ? 'connect_error' : 'tls_error';
}

/**
 * @param {object} [opt]
 * @param {(o:object)=>import('node:tls').TLSSocket} [opt.connect] 시험용 주입
 * @param {()=>number} [opt.now]
 * @param {number} [opt.timeoutMs]
 * @returns {Promise<{result:string, tcpMs:(number|null), tlsMs:(number|null)}>}
 */
export function probeHiraConnection(opt = {}) {
  const connect = opt.connect || ((o) => tls.connect(o));
  const now = opt.now || Date.now;
  const timeoutMs = Number.isFinite(opt.timeoutMs) ? opt.timeoutMs : PROBE_TIMEOUT_MS;
  const started = now();
  return new Promise((resolve) => {
    let stage = 'tcp';
    let tcpMs = null;
    let done = false;
    let sock = null;
    const finish = (result, tlsMs = null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { if (sock) sock.destroy(); } catch { /* noop */ }
      resolve({ result, tcpMs, tlsMs });
    };
    const timer = setTimeout(() => finish(stage === 'tcp' ? 'connect_timeout' : 'tls_timeout'), timeoutMs);
    try {
      sock = connect({ host: HIRA_PROBE_HOST, port: 443, servername: HIRA_PROBE_HOST });
    } catch (e) {
      finish(classify(e, stage));
      return;
    }
    sock.once('connect', () => { stage = 'tls'; tcpMs = Math.max(0, Math.round(now() - started)); });
    sock.once('secureConnect', () => {
      if (tcpMs === null) tcpMs = Math.max(0, Math.round(now() - started));
      finish('ok', Math.max(0, Math.round(now() - started)));
    });
    sock.once('error', (e) => finish(classify(e, stage)));
  });
}
