# 배포 가이드 — 120 라이프홈즈

목표 구성: **GitHub(Private) + Vercel + 독립 도메인 + (이후) Supabase**

---

## 0. 도메인 확인 결과 (2026-08-28 기준)

| 도메인 | 상태 |
|---|---|
| `120lifehomes.com` | ✅ **미등록 — 구매 가능** (Verisign RDAP 404 확인) |
| `120lifehomes.co.kr` | 등록 정보 미확인 — DNS 레코드 없음(미사용). 가비아/후이즈에서 최종 확인 필요 |

권장: `.com`을 주 도메인으로 확보(가장 간단), 여유 있으면 `.co.kr`도 방어 등록 후 `.com`으로 리다이렉트.

---

## 1. 도메인 구매

- `.com` : Cloudflare Registrar(원가, 약 $10~11/년) 또는 가비아
- `.co.kr` : 가비아 / 후이즈 / Cafe24 (국내 등록기관만 가능, 약 2만 원/년)

> 구매만 하고 네임서버는 그대로 두세요. 3번에서 Vercel 값으로 바꿉니다.

---

## 2. GitHub 저장소 만들기 (Private)

1. https://github.com/new
2. Repository name: `120lifehomes` (원하는 이름)
3. **Private** 선택, 나머지 빈 상태로 `Create repository`
4. 생성 후 나오는 주소(예: `https://github.com/사용자명/120lifehomes.git`)를 복사

그 다음 이 폴더에서 (제가 실행하거나, 아래를 직접 실행):

```bash
git remote add origin https://github.com/사용자명/120lifehomes.git
git push -u origin main
```

> 푸시할 때 GitHub 로그인/토큰이 필요합니다. 브라우저 인증(GitHub CLI) 또는
> Personal Access Token 방식 중 편한 것으로. 이 단계는 계정 주인이 직접 해야 합니다.

---

## 3. Vercel 연결

1. https://vercel.com/signup → **Continue with GitHub**
2. `Add New...` → `Project` → 방금 만든 `120lifehomes` 저장소 `Import`
3. Framework Preset: **Other** (지금은 순수 정적) / Root Directory: 그대로
4. `Deploy` → 1~2분 후 `120lifehomes.vercel.app` 같은 임시 주소 생성

### 독립 도메인 연결
5. 프로젝트 → `Settings` → `Domains` → `120lifehomes.com` 입력 → `Add`
6. Vercel이 아래 중 하나를 안내함:
   - **A 레코드**: `76.76.21.21` (도메인 관리페이지 DNS에 입력), 또는
   - **네임서버 변경**: `ns1.vercel-dns.com` / `ns2.vercel-dns.com`
7. 도메인 등록기관 관리페이지에서 위 값 입력 → 몇 분~수 시간 후 자동 HTTPS 발급 완료
8. `www.120lifehomes.com` → `120lifehomes.com` 리다이렉트도 Domains 화면에서 설정

> 이후 제가 코드를 수정·커밋하면 Vercel이 자동으로 다시 배포합니다.

---

## 4. 백엔드 — Supabase + 공공데이터 연동

코드는 이미 추가됨:
- `db/schema.sql` — Supabase 테이블(facilities / consultations / reviews) + RLS
- `lib/db.js` — Supabase REST 래퍼 (service_role, 의존성 없음)
- `api/consult.js` — 상담 접수 저장 (POST /api/consult)
- `api/facilities.js` — 시설 검색 (GET /api/facilities?sido=&type=&q=&...)
- `api/facility.js` — 시설 상세 (GET /api/facility?id=)
- `api/ingest.js` — 공공데이터 수집 (GET /api/ingest, Vercel Cron 매일 03:00 KST)
- `vercel.json` → `crons` 등록

### 4-1. Supabase
1. https://supabase.com → Continue with GitHub → **New project**
   - Region: **Northeast Asia (Seoul)**, DB 비밀번호 저장
2. **Settings → API** 에서 복사: `Project URL`, `service_role` `secret` key
3. **SQL Editor** → `db/schema.sql` 내용 붙여넣고 **Run**

### 4-2. 공공데이터포털
1. https://www.data.go.kr 회원가입
2. https://www.data.go.kr/data/15059029/openapi.do → **활용신청** (자동승인)
3. 마이페이지 → 오픈API → 인증키 → **일반 인증키(Decoding)** 복사

### 4-3. Vercel 환경변수 (Settings → Environment Variables, 세 환경 모두 체크)
| Key | Value |
|---|---|
| `SUPABASE_URL` | Supabase Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service_role key |
| `DATA_GO_KR_KEY` | 공공데이터포털 Decoding 키 |
| `CRON_SECRET` | 아무 길고 랜덤한 문자열 |

입력 후 **Deployments → 최신 배포 → Redeploy** (환경변수 반영).

### 4-4. 첫 수집 & 확인
1. 오퍼레이션/필드 확인:  `https://120lifehomes.com/api/ingest?mode=probe&secret=<CRON_SECRET>`
2. 매핑 미리보기:        `https://120lifehomes.com/api/ingest?mode=sample&secret=<CRON_SECRET>`
   → 필드명이 다르면 Claude 가 `api/ingest.js` 의 `mapRecord()` 수정
3. 전체 수집:            `https://120lifehomes.com/api/ingest?secret=<CRON_SECRET>`
4. 확인:                `https://120lifehomes.com/api/facilities?sido=서울`
5. 그 다음 Claude 가 `search.html` / `facility.html` 를 API 연동으로 전환

---

## 담당 구분

| 항목 | 실행 주체 |
|---|---|
| 도메인 구매, 계정 가입(GitHub/Vercel/Supabase/data.go.kr), 키 발급, DNS 값 입력, 최초 git push 인증 | **사용자 본인** |
| 코드 작성, 커밋, 스키마 설계, API·수집 스크립트, 관리자 페이지, 설정 파일, 단계별 안내 | **Claude** |
