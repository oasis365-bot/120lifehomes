# DB 마이그레이션 — Supabase SQL Editor 수동 실행 가이드

CLI 를 쓰지 않습니다. **Supabase 대시보드 → SQL Editor** 에서 아래 순서대로 실행합니다.

## 파일

| 순서 | 파일 | 성격 | 변경 |
|---|---|---|---|
| 1 | `000_preflight.sql` | 읽기 전용 점검 | 없음 (SELECT only) |
| 2 | `001_hospital_module_up.sql` | 마이그레이션 (ADDITIVE) | `begin; … commit;` 트랜잭션 |
| 3 | `002_verify.sql` | 읽기 전용 검증 | 없음 (SELECT only) |
| (롤백) | `001_hospital_module_down.sql` | 되돌리기 | 최후 수단 |

`db/baseline_schema.sql` = 현재 운영 DB 상태 문서(참고).

---

## 원칙
- **ADDITIVE 전용.** 기존 컬럼 rename/drop/type change, 기존 데이터 delete/재생성 없음.
- 시설은 물리 삭제하지 않고 상태값으로 비공개·폐업 처리 (감사기록 보존).
- 브라우저 자동 번역 OFF (supabase.com) — 예전에 SQL 화면이 왜곡된 적 있음.
- cron(`/api/ingest` 03:00 KST, `/api/enrich` 04:00 KST) 시간대는 피해서 실행.
- 운영 DB 접속정보·비밀키는 이 문서/스크립트에 넣지 않음.

---

## STEP 0 — facilities 백업 (필수, 1회)

Supabase 대시보드 → Table Editor → `facilities` → 우상단 **Export → CSV** (또는 SQL Editor):
```sql
-- 백업 대용: 행 수와 id 목록 해시만이라도 남겨두면 사후 대조 가능
select count(*) as total,
       md5(string_agg(id, ',' order by id)) as id_fingerprint
from public.facilities;
```
`total` 과 `id_fingerprint` 를 메모 → STEP 4 에서 대조.

---

## STEP 1 — `000_preflight.sql` 실행

SQL Editor 에 파일 전체 붙여넣고 **RUN**.

**[A] 결과 표** 의 `verdict` 열을 본다:

| verdict | 의미 | 조치 |
|---|---|---|
| 전부 `OK` (A9 만 `WARN` 은 허용) | 깨끗한 상태 | STEP 2 진행 |
| 하나라도 `STOP` | 예상과 다른 상태 (컬럼/테이블/제약 이미 존재, 행 0, id 중복 등) | **001 실행 금지.** [A] 결과 캡처해서 보고 |
| A9 `WARN` | facilities 에 트리거 존재 | 트리거 내용 확인 후 판단 (대개 문제 없음) |

**preflight 정상 판정 기준 (모두 만족해야 STEP 2)**
- A1 = OK (facilities 존재)
- A2 = OK (행 수 > 0) — 이 값을 메모
- A3 = OK (id 중복 0)
- A4·A5·A6 = OK (domain/source/hira_ykiho 컬럼 없음)
- A7 = OK (신규 테이블 8개 모두 아직 없음)
- A8 = OK (제약·인덱스 이름 충돌 없음)
- [B5] type_label 분포에 `요양병원` 이 **없어야** 함

---

## STEP 2 — `001_hospital_module_up.sql` 실행

preflight 가 전부 OK 일 때만. SQL Editor 에 파일 전체 붙여넣고 **RUN**.

- 스크립트는 `begin; … commit;` 로 감싸여 있어 **중간 실패 시 전체 자동 롤백** (아무것도 적용 안 됨).
- 성공하면 편집기에 에러 없이 완료. (마지막에 `INSERT 0 1` 등 표시)
- 만약 편집기가 트랜잭션 블록을 무시하고 문장별 실행하다 중간에 실패하면
  → `001_hospital_module_down.sql` 로 정리한 뒤 원인 파악 후 재시도.

이 마이그레이션이 하는 일:
1. `schema_migrations`, `feature_flags` 생성 (+ `hospital_module = false` 시드)
2. `facilities` 에 `domain` / `source` / `hira_ykiho` 컬럼 추가 (ADDITIVE)
3. 기존 전 행을 `domain = 'LTC'`, `source = 'ltc_public'` 로 백필
4. `facilities_domain_chk` CHECK (`domain in ('LTC','HOSPITAL')`),
   `uq_facilities_hira_ykiho` 부분 UNIQUE, `idx_facilities_domain(_sido)` 인덱스
5. 신규 테이블 6개 생성:
   `hospital_profiles`, `facility_evaluations`, `facility_sources`,
   `facility_revisions`, `facility_duplicate_candidates`, `ingestion_runs`
6. 신규 테이블 전부 RLS enable (정책 0개 = service_role 전용, 기존 패턴)
7. `schema_migrations` 에 `001_hospital_module` 기록

---

## STEP 3 — `002_verify.sql` 실행

001 직후, SQL Editor 에 파일 전체 붙여넣고 **RUN**.

**[C] 결과 표** 의 `verdict`:

| 항목 | 기대 | verdict |
|---|---|---|
| C1 facilities 행 수 | preflight A2 와 **동일** | INFO (직접 대조) |
| C2 domain=LTC == 전체 | true | **OK** |
| C3 domain IS NULL | 0 | **OK** |
| C4 domain=HOSPITAL | 0 | **OK** |
| C5 source=ltc_public == 전체 | true | **OK** |
| C6 알려진 id 보존 | true | OK (그 id 가 원래 있었으면) |
| C7 신규 테이블 8개 | 8 | **OK** |
| C8 추가 컬럼 3개 | 3 | **OK** |
| C9 CHECK 제약 | 존재 | **OK** |
| C10 부분 UNIQUE 인덱스 | 존재 | **OK** |
| C11 facility_sources 복합 UNIQUE | 존재 | **OK** |
| C12 hospital_module 플래그 | false | **OK** |
| C13 마이그레이션 기록 | 존재 | **OK** |
| C14 신규 테이블 RLS 8개 | 8 | **OK** |
| C15 / C15b eval_grade·phone 채워진 행 수 | preflight 대비 **감소 없음** | INFO (직접 대조) |

**성공 기준**: `FAIL` 이 하나도 없고, C1 == preflight A2, C15/C15b 가 마이그레이션 전과 같거나 크다.
STEP 0 의 `id_fingerprint` 를 다시 계산해 동일한지 대조하면 확실:
```sql
select md5(string_agg(id, ',' order by id)) from public.facilities;
```

`FAIL` 이 있으면 → [C] 결과 캡처해서 보고. 필요 시 롤백.

---

## STEP 4 — 배포 (별도 승인)

마이그레이션이 검증되면, 코드(브랜치 `feature/hospital-module-1a`) 를 preview 로 배포하고
`test/regression_hospital_off.md` 의 C·D 회귀 테스트 수행. **이건 별도 승인 후.**

---

## 롤백 / 비활성화

| 상황 | 방법 | 영향 |
|---|---|---|
| 병원 모듈만 끄기 | `update public.feature_flags set enabled=false, updated_at=now() where key='hospital_module';` | 즉시. 요양원 화면 완전 동일. 데이터·스키마 유지 |
| 1A 코드 문제 | Vercel 이전 배포로 Rollback (1A 는 아직 미배포) | 없음 |
| 요양병원 데이터만 제거 | `delete from public.facilities where domain='HOSPITAL';` | `hospital_profiles`·`facility_evaluations`·`facility_duplicate_candidates` 는 CASCADE 삭제. `facility_sources`·`facility_revisions` 는 **링크만 NULL, 기록 보존** |
| 스키마 원복 (최후) | `001_hospital_module_down.sql` 실행 | 신규 6테이블 DROP, facilities 의 domain/source/hira_ykiho 컬럼 DROP. **facilities 기존 행은 삭제 안 됨** |

## 다음 (별도 승인 후)
- `003_*` : `facilities.domain NOT NULL` 확정 (백필 검증 완료 후)
- `004_*` : 실제 심평원 응답 샘플 확보 후 필드 매핑에 따른 컬럼/인덱스 보강 (1B)
