# 회귀 테스트 — hospital_module = OFF

목표: **병원 모듈이 꺼져 있으면 기존 요양원 서비스가 한 픽셀도 안 바뀐다**를 증명.

1A 는 배포하지 않으므로, 아래는 (a) 코드 근거 + (b) 마이그레이션 후 운영 DB 확인 +
(c) 나중에 1A 브랜치를 preview 로 배포했을 때 실행할 비교 스크립트로 구성.

---

## A. 코드 근거 (배포 없이 확인 가능)

| 변경 파일 | OFF 일 때 동작 | 근거 |
|---|---|---|
| `api/facilities.js` | `select` 에 `domain` **미포함**, 필터에 `domain=eq.LTC` **추가** | `hospitalOn=false` → `BASE_SELECT` 그대로. `schemaReady` 이면 `domain=eq.LTC` 만 덧붙음 |
| 〃 | 마이그레이션 전(`schemaReady=false`)엔 `domain` 절 자체가 없음 | `if (schemaReady)` 가드 |
| `api/flags.js` | 신규 엔드포인트 — 기존 화면은 호출 안 함 (1A 프런트 변경 없음) | search.html/facility.html 미수정 |
| `lib/flags.js` | 60초 캐시, 오류 시 전부 OFF | try/catch → `flags={}` |
| `db/migrations/001` | `facilities` 에 컬럼 3개 additive, 전 행 `domain='LTC'` 백필 | `ADD COLUMN` + `DEFAULT` + 명시적 `UPDATE` |
| 그 외 | 요양원 `ingest/enrich/import`, `lib/db.js`, 프런트, `vercel.json` **무수정** | git diff |

**핵심 등식**: 전 행이 `domain='LTC'` 이므로
`SELECT ... FROM facilities` ≡ `SELECT ... FROM facilities WHERE domain='LTC'`
→ OFF 일 때 `/api/facilities` 결과(행·정렬·total)와 응답 형태 모두 기존과 동일.

---

## B. 마이그레이션 직후 운영 DB 확인 (Supabase SQL Editor)

```sql
-- B1. 행 수 불변 + 전량 LTC
select
  (select count(*) from public.facilities)                          as total,
  (select count(*) from public.facilities where domain = 'LTC')     as ltc,
  (select count(*) from public.facilities where domain is null)     as null_domain,
  (select count(*) from public.facilities where domain = 'HOSPITAL')as hospital;
-- 기대:  total == ltc,  null_domain == 0,  hospital == 0

-- B2. 기존 컬럼 무손상 (샘플)
select id, name, type_label, sido, sigungu_nm, address, phone,
       capacity, current_count, eval_grade, eval_date, established_at
from public.facilities
order by id
limit 20;
-- 마이그레이션 전 같은 쿼리 결과와 비교 (0번 백업본과 대조)

-- B3. 신규 테이블/제약
select conname, pg_get_constraintdef(oid)
from pg_constraint where conrelid = 'public.facilities'::regclass
order by conname;
-- 기존 제약 + facilities_domain_chk, uq_facilities_hira_ykiho(인덱스) 만 추가

-- B4. 플래그
select key, enabled from public.feature_flags;   -- hospital_module | false
```

`/api/facilities` (현재 배포된 main 코드) 는 마이그레이션만으로는 전혀 안 바뀜
(domain 을 select/filter 하지 않으므로). B1~B4 통과면 마이그레이션 안전.

---

## C. 1A 브랜치를 preview 로 배포한 뒤 (별도 승인 시)

`test/compare_facilities_api.mjs` 로 **현재 프로덕션(main)** vs **preview(1A)** 응답을 비교.

```bash
node test/compare_facilities_api.mjs \
  --base-a https://www.120lifehomes.com \
  --base-b https://<preview-배포-URL>
```

- 스크립트는 대표 쿼리 세트를 두 서버에 던져 JSON 을 정규화 비교.
- `hospital_module=OFF` 상태에서 **모든 쿼리의 items(정렬 포함)·total 이 동일**해야 통과.
- `--base-b` 에서 `/api/flags` 가 `{"hospital_module":false}` 인지도 확인.

### 대표 쿼리 세트 (스크립트에 포함)
```
/api/facilities
/api/facilities?sido=서울
/api/facilities?sido=경기&sort=new
/api/facilities?sido=서울&sigungu_nm=강남구
/api/facilities?type=노인요양시설
/api/facilities?type=주야간보호&sido=부산
/api/facilities?grade=A&sido=서울
/api/facilities?q=행복
/api/facilities?sido=광주            (파일데이터 전용 지역)
/api/facilities?sido=전남
/api/facilities?page=3&size=20&sido=경기
/api/facilities?domain=HOSPITAL      (OFF 이면 무시되어 요양원 결과와 동일해야 함)
```

---

## C-2. 1A 보완 변경 회귀 (preview)

| 변경 | 확인 |
|---|---|
| `api/facility.js` select 축소 (`*` → 공개 컬럼) | 시설 상세페이지 전 항목 정상 렌더 (주소·전화·정원·현원·평가등급·지정일·우편·지도링크). 응답에 `raw`·`monthly_fee` 등 미포함 |
| `api/admin/consultations.js` select 축소 | 관리자 표 12개 열 정상. 응답에 `source_ip`·`user_agent` 미포함 |
| `api/facilities.js` select 를 `lib/facilitySelect.js` 공유 | `/api/facilities` 응답 필드가 1A 이전과 동일 (id~is_partner) |
| `api/env-check.js` | `?secret=` 없이 호출 시(운영에 CRON_SECRET 설정됨) `401`. `?secret=<CRON_SECRET>` 시 `{configured:...}` 만, **키 문자열·앞뒤자리·길이 없음** |

## D. 프런트 스모크 (1A 브랜치 preview, 수동)

hospital_module = OFF 상태에서:

- [ ] `index.html` — 통계·검색폼·지역/유형 그리드·최근 지정 기관·FAQ 이전과 동일
- [ ] `search.html` — 필터(시도·시군구·유형·등급·기관명)·정렬·더보기·URL 복원·0건 메시지, **요양병원 탭 없음**
- [ ] `facility.html` — 요양원 상세 전 블록, 네이버/카카오 링크, 같은 지역 다른 기관
- [ ] `consult.html` 제출 → 완료, `admin.html` 로그인 → 목록 → 상태변경
- [ ] guide 6편, 헤더/푸터, 글자 크기 조절
- [ ] 모바일 360~430px 에서 위 전부
- [ ] DevTools Network 에 `supabase.co` 직접요청 0건, `/api/*` 만

---

## 결과 기록 (실행 시 채움)

| 체크 | 상태 | 비고 |
|---|---|---|
| A 코드 근거 | ✅ (정적 확인) | 아래 "생성·수정 파일" 참조 |
| B1~B4 DB 확인 | ⬜ PENDING | 마이그레이션 미실행 (운영 DB 접근 불가) |
| C API 비교 | ⬜ PENDING | 1A preview 배포 후 |
| D 프런트 스모크 | ⬜ PENDING | 1A preview 배포 후 |
