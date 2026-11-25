import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { probeHiraConnection, HIRA_PROBE_HOST, PROBE_RESULTS } from '../../lib/hira/net_probe.js';

function fakeSocket() {
  const s = new EventEmitter();
  s.destroyed = false;
  s.destroy = () => { s.destroyed = true; };
  return s;
}

test('연결·TLS 성공 → ok, 단계별 ms, 소켓은 바로 닫는다(HTTP 요청 없음)', async () => {
  let t = 0;
  let sock;
  let opts;
  const p = probeHiraConnection({
    now: () => t,
    connect: (o) => { opts = o; sock = fakeSocket(); return sock; },
  });
  t = 40; sock.emit('connect');
  t = 95; sock.emit('secureConnect');
  const r = await p;
  assert.deepEqual(r, { result: 'ok', tcpMs: 40, tlsMs: 95 });
  assert.equal(sock.destroyed, true);
  assert.equal(opts.host, HIRA_PROBE_HOST);
  assert.equal(opts.port, 443);
});

test('TCP 연결이 제한 안에 안 되면 connect_timeout, 연결 뒤 TLS 가 멈추면 tls_timeout', async () => {
  const r1 = await probeHiraConnection({ timeoutMs: 20, connect: () => fakeSocket() });
  assert.deepEqual(r1, { result: 'connect_timeout', tcpMs: null, tlsMs: null });
  let sock;
  const p = probeHiraConnection({ timeoutMs: 30, now: () => 7, connect: () => { sock = fakeSocket(); return sock; } });
  sock.emit('connect');
  const r2 = await p;
  assert.equal(r2.result, 'tls_timeout');
  assert.equal(r2.tlsMs, null);
});

test('오류 종류는 allowlist 로만 분류하고 원문은 내보내지 않는다', async () => {
  const cases = [['ENOTFOUND', 'dns_error'], ['ECONNREFUSED', 'connect_refused'], ['EHOSTUNREACH', 'connect_error']];
  for (const [code, want] of cases) {
    let sock;
    const p = probeHiraConnection({ connect: () => { sock = fakeSocket(); return sock; } });
    const e = new Error(`connect ${code} 27.101.236.63:443 secret`); e.code = code;
    sock.emit('error', e);
    // eslint-disable-next-line no-await-in-loop
    const r = await p;
    assert.equal(r.result, want);
    assert.ok(PROBE_RESULTS.includes(r.result));
    assert.doesNotMatch(JSON.stringify(r), /27\.101|secret|connect /);
  }
});

test('정적: 점검은 tls 연결만 하고 HTTP 요청·키를 쓰지 않는다', () => {
  const src = readFileSync(new URL('../../lib/hira/net_probe.js', import.meta.url), 'utf8').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(src, /fetch\(|\.write\(|serviceKey|DATA_GO_KR_KEY|GET /);
});
