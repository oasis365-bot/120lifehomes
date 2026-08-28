# 배포 가이드 — 케어홈즈

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
2. Repository name: `carehomes` (원하는 이름)
3. **Private** 선택, 나머지 빈 상태로 `Create repository`
4. 생성 후 나오는 주소(예: `https://github.com/사용자명/carehomes.git`)를 복사

그 다음 이 폴더에서 (제가 실행하거나, 아래를 직접 실행):

```bash
git remote add origin https://github.com/사용자명/carehomes.git
git push -u origin main
```

> 푸시할 때 GitHub 로그인/토큰이 필요합니다. 브라우저 인증(GitHub CLI) 또는
> Personal Access Token 방식 중 편한 것으로. 이 단계는 계정 주인이 직접 해야 합니다.

---

## 3. Vercel 연결

1. https://vercel.com/signup → **Continue with GitHub**
2. `Add New...` → `Project` → 방금 만든 `carehomes` 저장소 `Import`
3. Framework Preset: **Other** (지금은 순수 정적) / Root Directory: 그대로
4. `Deploy` → 1~2분 후 `carehomes.vercel.app` 같은 임시 주소 생성

### 독립 도메인 연결
5. 프로젝트 → `Settings` → `Domains` → `120lifehomes.com` 입력 → `Add`
6. Vercel이 아래 중 하나를 안내함:
   - **A 레코드**: `76.76.21.21` (도메인 관리페이지 DNS에 입력), 또는
   - **네임서버 변경**: `ns1.vercel-dns.com` / `ns2.vercel-dns.com`
7. 도메인 등록기관 관리페이지에서 위 값 입력 → 몇 분~수 시간 후 자동 HTTPS 발급 완료
8. `www.120lifehomes.com` → `120lifehomes.com` 리다이렉트도 Domains 화면에서 설정

> 이후 제가 코드를 수정·커밋하면 Vercel이 자동으로 다시 배포합니다.

---

## 4. (이후 단계) 백엔드 — Supabase + 공공데이터 연동

이 폴더에 추가될 것들 (아직 없음):
- `.env.example` → 실제 키는 `.env`(로컬)와 Vercel 환경변수에만
- `api/` 또는 `app/api/` — 상담접수 저장, 시설 조회 API
- `scripts/ingest.*` — 공공데이터포털(장기요양기관 검색 서비스) 일 1회 수집 → Supabase upsert
- `admin/` — 상담 접수 목록·시설 관리 페이지

Supabase 준비:
1. https://supabase.com → GitHub 로그인 → `New project` (Region: **Northeast Asia (Seoul)**)
2. `Project URL` 과 `anon key`, `service_role key` 확보 → Vercel 환경변수에 입력
3. 제공되는 SQL 편집기에 제가 만든 테이블 스키마 실행

공공데이터포털:
1. https://www.data.go.kr → 회원가입
2. "국민건강보험공단_장기요양기관 검색 서비스" 활용신청 → 서비스키 발급
3. 서비스키를 Vercel 환경변수 `DATA_GO_KR_KEY` 로 저장

---

## 담당 구분

| 항목 | 실행 주체 |
|---|---|
| 도메인 구매, 계정 가입(GitHub/Vercel/Supabase/data.go.kr), 키 발급, DNS 값 입력, 최초 git push 인증 | **사용자 본인** |
| 코드 작성, 커밋, 스키마 설계, API·수집 스크립트, 관리자 페이지, 설정 파일, 단계별 안내 | **Claude** |
