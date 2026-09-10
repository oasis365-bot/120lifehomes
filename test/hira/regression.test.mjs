// 15. 기존 요양원 기능 회귀 — 정적 불변식 확인
//   (요양원 자동화 유닛테스트는 없음. 아래는 "병원 코드가 LTC 경로를 건드리지 않음"을 코드로 고정.
//    라이브 회귀는 test/regression_hospital_off.md + test/compare_facilities_api.mjs, SSO 해제 후 실행.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  normalizeHospitalRecord,
  HOSPITAL_DOMAIN,
} from '../../lib/hira/adapter.js';
import { parseHiraResponse } from '../../lib/hira/parse.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => readFileSync(root + p, 'utf8');

test('adapter 는 domain=HOSPITAL 만 생성 (001 CHECK 값과 일치, LTC 아님)', () => {
  assert.equal(HOSPITAL_DOMAIN, 'HOSPITAL');
  const basis = parseHiraResponse(
    read('test/hira/fixtures/hospBasisList_one.json')
  ).items[0];
  const n = normalizeHospitalRecord({ basis });
  assert.equal(n.domain, 'HOSPITAL');
  assert.notEqual(n.domain, 'LTC');
});

test('lib/hira 모듈은 lib/db 를 import 하지 않는다 (persist 는 sb 주입 방식)', () => {
  for (const f of ['client.js', 'parse.js', 'adapter.js', 'collect.js', 'persist.js']) {
    const src = read(`lib/hira/${f}`);
    assert.equal(/from ['"].*\/db\.js['"]/.test(src), false, `${f} 가 db.js import`);
  }
});

test('1B-3A: api/hospital/ingest.js 는 HOSPITAL_INGEST_PERSIST 게이트 뒤에서만 persist', () => {
  const src = read('api/hospital/ingest.js');
  assert.ok(src.includes("env.HOSPITAL_INGEST_PERSIST !== '1'"), 'persist 게이트 없음');
  assert.ok(src.includes('persist_disabled'), '비활성 응답 없음');
  assert.ok(src.includes('assertPreviewDb') || src.includes('assertDb'), '운영 DB 안전점검 없음');
  // dryRun 기본 true (dryRun=false 만 persist 경로)
  assert.ok(src.includes("String(q.dryRun) === 'false'"));
});

test('1B-3B 안전: persist.js 는 hostname 을 정확 일치(===)로만 비교, 허용 host 는 env 로만', () => {
  const src = read('lib/hira/persist.js');
  // verifyPreviewDbUrl 존재 + URL 파싱
  assert.ok(src.includes('function verifyPreviewDbUrl'), 'verifyPreviewDbUrl 없음');
  assert.ok(/new URL\(/.test(src), 'URL 파싱 안 함');
  assert.ok(/u\.hostname !== host\b/.test(src), 'hostname 정확 비교(!==) 없음');
  // 부분 일치 함수 금지 (hostname 비교에)
  assert.equal(/\.hostname[^\n]*\.(includes|endsWith|startsWith)\(/.test(src), false, 'hostname 부분 비교 사용');
  // protocol https 확인
  assert.ok(src.includes("u.protocol !== 'https:'"));
  // 실패 reason 은 wrong_preview_db 만
  assert.ok(src.includes("reason: 'wrong_preview_db'"));
  // 허용 hostname 은 env(HOSPITAL_INGEST_DB_HOST) 로만 — 코드에 실제 프로젝트 ref 하드코딩 금지
  assert.ok(src.includes('HOSPITAL_INGEST_DB_HOST'), '허용 host env 이름 없음');
  assert.equal(/['"][a-z0-9]{16,}\.supabase\.co['"]/.test(src), false, 'Supabase 프로젝트 ref 하드코딩됨');
  assert.equal(src.includes('EXPECTED_PREVIEW_DB_HOST'), false, '구 하드코딩 상수 잔존');
});

test('1B-3B 안전: 허용 host 미지정이면 verifyPreviewDbUrl 은 fail-closed', async () => {
  const { verifyPreviewDbUrl, allowedIngestDbHost } = await import('../../lib/hira/persist.js');
  assert.equal(allowedIngestDbHost({}), null);
  const u = 'https://anything.supabase.co';
  for (const host of [undefined, null, '', '   ']) {
    const r = verifyPreviewDbUrl(u, host);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'wrong_preview_db');
  }
});

test('1B-4A: profileDiff 는 source-aware — blanket forward-fill(값 비었으면 무조건 skip) 아님', () => {
  const src = read('lib/hira/persist.js');
  // profileDiff 가 3번째 인자(sources)를 받고, endpoint 게이트로만 skip 한다
  assert.ok(/function profileDiff\(existing, next, sources\)/.test(src), 'profileDiff(sources) 시그니처');
  assert.ok(src.includes('fieldSourcesOk'), 'endpoint 게이트 함수 없음');
  assert.ok(src.includes('PROFILE_FIELD_SOURCES'), '필드→endpoint 매핑 없음');
  // "값이 null/[]/{} 이면 skip" 같은 값 기반 blanket 조건이 없어야 함
  assert.equal(/if\s*\(\s*(next\[k\]|value)\s*(==|===)\s*null\s*\)\s*continue/.test(src), false, 'blanket forward-fill 금지');
  // 0/false 를 빈 값으로 취급하는 코드 없음
  assert.equal(/!\s*next\[k\]\s*\)\s*continue/.test(src), false, '0/false 를 빈 값 취급');
});

test('1B-4A: 내부 sources 상태는 저장·응답 경로에 문자열로 들어가지 않음 (정적 스캔)', () => {
  for (const f of ['collect.js', 'persist.js']) {
    const src = read(`lib/hira/${f}`);
    // rawBundle / facility_sources body / 응답 객체에 sources 를 넣는 코드가 없어야 함
    assert.equal(/raw:\s*\{[^}]*sources/.test(src), false, `${f}: raw 에 sources`);
    assert.equal(/rawBundle[^;]*sources/.test(src), false, `${f}: rawBundle 에 sources`);
  }
  // collect 의 rawBundle 필드 목록에 sources 없음
  const c = read('lib/hira/collect.js');
  const rawBlock = c.slice(c.indexOf('const rawBundle'), c.indexOf('const rawBundle') + 400);
  assert.equal(rawBlock.includes('sources'), false, 'rawBundle 정의에 sources 포함됨');
});

test('1B-4A: 기존 LTC 파일 무변경 (이 브랜치는 lib/hira + api/hospital 만 건드림)', () => {
  // 이 테스트는 정적 신호만 — 실제 diff 는 CI 의 main 대비 비교로 확인.
  for (const f of ['api/facilities.js', 'api/facility.js', 'api/ingest.js', 'api/enrich.js', 'api/consult.js', 'lib/db.js', 'lib/facilitySelect.js']) {
    const src = read(f);
    assert.equal(/hira\/(collect|adapter|persist)/.test(src), false, `${f} 가 hira 모듈 참조`);
  }
});

test('기존 요양원 수집기/정규화 파일은 이 브랜치에서 변경되지 않음', () => {
  // 파일 존재 + 핵심 시그니처만 확인 (내용 변경 여부는 git diff 로 별도 검증)
  const ingest = read('api/ingest.js');
  assert.ok(ingest.includes('searchLtcInsttService02'));
  assert.ok(ingest.includes('B550928'));
  const enrich = read('api/enrich.js');
  assert.ok(enrich.includes('getLtcInsttDetailInfoService02'));
  const facilities = read('api/facilities.js');
  assert.ok(facilities.includes("flagOn(flags, 'hospital_module')"));
  assert.ok(facilities.includes("p.append('domain', 'eq.LTC')")); // OFF 시 LTC 고정 유지
});

test('임시 수집기(api/hira-probe.js)는 이 브랜치에 없다', () => {
  const apiFiles = readdirSync(root + 'api');
  assert.equal(apiFiles.includes('hira-probe.js'), false);
});

test('facilitySelect 공개 컬럼에 내부 필드(raw/hira_ykiho/source/domain)가 없다', async () => {
  const { FACILITY_PUBLIC_COLUMNS } = await import('../../lib/facilitySelect.js');
  const cols = FACILITY_PUBLIC_COLUMNS.split(',');
  for (const bad of ['raw', 'hira_ykiho', 'source', 'domain', 'normalized_hash', 'synced_at']) {
    assert.equal(cols.includes(bad), false, `공개 컬럼에 ${bad} 포함됨`);
  }
});
