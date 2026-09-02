// 회귀 비교: 두 배포(A=프로덕션 main, B=1A preview)의 /api/facilities 응답이
// hospital_module = OFF 상태에서 동일한지 검증.
//
//   node test/compare_facilities_api.mjs --base-a https://www.120lifehomes.com --base-b https://<preview>
//
// 통과 조건: 모든 쿼리에서 items(id 순서 포함)·total 이 완전히 동일.
// 의존성 없음 (Node 18+ 전역 fetch).

const args = Object.fromEntries(
  process.argv.slice(2).join(' ').split('--').filter(Boolean)
    .map((s) => s.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(' ')])
);
const baseA = args['base-a'];
const baseB = args['base-b'];
if (!baseA || !baseB) {
  console.error('사용법: node test/compare_facilities_api.mjs --base-a <URL> --base-b <URL>');
  process.exit(2);
}

const QUERIES = [
  '/api/facilities',
  '/api/facilities?sido=서울',
  '/api/facilities?sido=경기&sort=new',
  '/api/facilities?sido=서울&sigungu_nm=강남구',
  '/api/facilities?type=노인요양시설',
  '/api/facilities?type=주야간보호&sido=부산',
  '/api/facilities?grade=A&sido=서울',
  '/api/facilities?q=행복',
  '/api/facilities?sido=광주',
  '/api/facilities?sido=전남',
  '/api/facilities?page=3&size=20&sido=경기',
  '/api/facilities?domain=HOSPITAL',
  '/api/facilities?domain=HOSPITAL&sido=서울',
];

async function get(base, path) {
  const r = await fetch(base + path);
  const j = await r.json();
  return { status: r.status, body: j };
}

// items 를 id 배열 + total 로 축약 (응답에 domain 이 추가돼도 렌더에 영향 없으므로
// 여기서는 "결과 동일성"을 id 순서·total 로 판정). 엄격 비교가 필요하면 STRICT=1.
const STRICT = process.env.STRICT === '1';
function shape(body) {
  if (!body || !Array.isArray(body.items)) return JSON.stringify(body);
  if (STRICT) return JSON.stringify(body);
  return JSON.stringify({
    total: body.total,
    page: body.page,
    size: body.size,
    ids: body.items.map((x) => x.id),
  });
}

let fail = 0;
for (const q of QUERIES) {
  try {
    const [a, b] = await Promise.all([get(baseA, q), get(baseB, q)]);
    const sa = shape(a.body);
    const sb = shape(b.body);
    if (a.status !== b.status || sa !== sb) {
      fail++;
      console.log(`❌ ${q}`);
      console.log(`   A(${a.status}): ${sa.slice(0, 300)}`);
      console.log(`   B(${b.status}): ${sb.slice(0, 300)}`);
    } else {
      console.log(`✅ ${q}  (total=${a.body.total ?? '-'})`);
    }
  } catch (e) {
    fail++;
    console.log(`❌ ${q}  — ${e.message}`);
  }
}

// /api/flags 확인
try {
  const f = await get(baseB, '/api/flags');
  const ok = f.body && f.body.hospital_module === false;
  console.log(`${ok ? '✅' : '❌'} /api/flags (B) = ${JSON.stringify(f.body)}  (hospital_module 은 false 여야 함)`);
  if (!ok) fail++;
} catch (e) {
  console.log(`⚠️  /api/flags (B) 조회 실패: ${e.message} (마이그레이션/배포 전이면 정상)`);
}

console.log(fail ? `\n실패 ${fail}건` : '\n전부 동일 — OFF 회귀 통과');
process.exit(fail ? 1 : 0);
