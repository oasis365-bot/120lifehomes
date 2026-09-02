# DB 마이그레이션 (수동 실행)

이 프로젝트는 마이그레이션 CLI 를 쓰지 않습니다. **Supabase 대시보드 → SQL Editor** 에
`.sql` 파일을 붙여넣어 순서대로 실행합니다.

## 원칙
- **ADDITIVE 전용.** 기존 컬럼 rename/drop/type change, 기존 데이터 delete/재생성 금지.
- 실행 전 `db/baseline_schema.sql` 의 [검증 쿼리]로 현재 스키마를 확인.
- 실행 전 `facilities` 데이터를 NDJSON 으로 export (아래).
- 브라우저 자동 번역 OFF (supabase.com) — 예전에 SQL 화면이 왜곡된 적 있음. 실제 실행은 원문으로 되지만 확인이 어려움.
- cron(`/api/ingest`, `/api/enrich`) 이 도는 시간대(KST 03~04시)는 피해서 실행.

## 실행 순서

### 0. 사전 — facilities 백업
로컬에서 (환경변수 필요) 또는 Supabase Table Editor → Export.
```bash
# 예: PostgREST 로 전량 내려받기 (service_role 키 필요, 로컬에서만)
#   30,000+ 행이면 페이지네이션 필요 — 아래는 개념
curl -s "$SUPABASE_URL/rest/v1/facilities?select=*" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Range-Unit: items" -H "Range: 0-999" > backup_facilities_0.json
# Range 를 1000-1999, 2000-2999 ... 로 반복
```

### 1. 검증 쿼리 실행 → baseline 확정
`db/baseline_schema.sql` 상단 주석의 쿼리 5개를 실행하고, 결과가 문서와 다르면
**여기서 멈추고 보고**. (특히 이미 존재하는 컬럼/인덱스)

### 2. `001_hospital_module_up.sql` 실행
파일 전체를 SQL Editor 에 붙여넣고 1회 실행. `begin; ... commit;` 로 묶여 있어
중간 실패 시 자동 롤백됨.

### 3. 실행 후 확인
```sql
select count(*) as total                          from public.facilities;
select count(*) as ltc     from public.facilities where domain = 'LTC';
select count(*) as null_domain from public.facilities where domain is null;   -- 0 이어야 함
select count(*) as hospital from public.facilities where domain = 'HOSPITAL'; -- 0 이어야 함
select key, enabled from public.feature_flags;                                -- hospital_module | false
select version, applied_at from public.schema_migrations;
-- 신규 테이블 존재 확인
select table_name from information_schema.tables
where table_schema='public' and table_name in
('feature_flags','hospital_profiles','facility_evaluations','facility_sources',
 'facility_revisions','facility_duplicate_candidates','ingestion_runs','schema_migrations')
order by table_name;
```
`total == ltc`, `null_domain == 0`, `hospital == 0` 이면 성공.

## 롤백 / 비활성화

| 상황 | 방법 |
|---|---|
| 병원 모듈만 끄고 싶다 (데이터·스키마 유지) | `update public.feature_flags set enabled=false where key='hospital_module';` → 즉시 반영, 기존 요양원 화면과 완전 동일 |
| 코드 문제 | Vercel 이전 배포로 Rollback (1A 코드는 `feature/hospital-module-1a` 브랜치라 아직 미배포) |
| 요양병원 데이터만 지우기 | `delete from public.facilities where domain='HOSPITAL';` (연결 테이블 CASCADE 삭제) |
| 스키마까지 원복 (최후 수단) | `001_hospital_module_down.sql` 실행. **facilities 기존 행은 유지**, domain/source/hira_ykiho 컬럼만 제거 |

## 다음 단계 (1B, 별도 승인 후)
- `002_*` : 실제 심평원 응답 샘플 확보 후 필드 매핑 확정 → 필요 시 컬럼/인덱스 보강
- `003_*` : `facilities.domain NOT NULL` 확정 (백필 검증 완료 후)
