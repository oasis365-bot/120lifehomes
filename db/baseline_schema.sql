-- =====================================================================
-- 120 라이프홈즈 — BASELINE SCHEMA (현재 운영 DB 기준 문서)
-- =====================================================================
--  목적: 요양병원 확장 migration 을 안전하게 작성하기 위한 "현재 상태" 기록.
--
--  ⚠️ 이 파일은 운영 DB 에 실행하지 마세요. 운영 DB 를 덮어쓰거나 재생성하지 않습니다.
--     이 파일은 코드 사용 흔적(api/*.js, db/schema.sql)에서 역추적한 것이며,
--     아래 "검증 쿼리"를 Supabase SQL Editor 에서 실행해 실제와 대조한 뒤 확정합니다.
--
--  작성: 2026-09-02  (1A 단계)
--  근거: db/schema.sql(부트스트랩), api/facilities.js·facility.js·ingest.js·
--        enrich.js·import.js·admin/consultations.js 의 실제 컬럼 사용
-- =====================================================================


-- ---------------------------------------------------------------------
-- [검증 쿼리] — Supabase SQL Editor 에서 실행 후 결과를 이 파일과 대조
-- ---------------------------------------------------------------------
/*
-- 1) 컬럼
select table_name, column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
order by table_name, ordinal_position;

-- 2) 인덱스
select tablename, indexname, indexdef
from pg_indexes
where schemaname = 'public'
order by tablename, indexname;

-- 3) 제약조건 (PK / FK / CHECK / UNIQUE)
select conrelid::regclass as table_name,
       conname,
       contype,
       pg_get_constraintdef(oid) as definition
from pg_constraint
where connamespace = 'public'::regnamespace
order by conrelid::regclass::text, conname;

-- 4) RLS 상태 및 정책
select relname, relrowsecurity, relforcerowsecurity
from pg_class
where relnamespace = 'public'::regnamespace and relkind = 'r';

select schemaname, tablename, policyname, cmd, qual, with_check
from pg_policies where schemaname = 'public';

-- 5) 행 수
select 'facilities' t, count(*) n from public.facilities
union all select 'consultations', count(*) from public.consultations
union all select 'reviews', count(*) from public.reviews;
*/


-- =====================================================================
-- TABLE: public.facilities   (전국 장기요양기관 — 공공데이터)
-- =====================================================================
--  db/schema.sql(초기 부트스트랩) + 이후 SQL Editor 로 직접 추가된 컬럼 포함.
--  ⚠️ db/schema.sql 에는 아래 [SQL Editor 추가] 표시 컬럼이 빠져 있음.
--
--  컬럼                     타입                기본값        비고
--  -----------------------  ------------------  ------------  --------------------------------
--  id                       text                (PK)          장기요양기관기호. 예 '11111000006'
--  name                     text (NOT NULL)
--  type_code                text                              급여종류 코드 (adminPttnCd, 예 'A03')
--  type_label               text                              급여종류 한글 ('노인요양시설' 등)
--  sido                     text                              시도명 ('서울' 등)
--  sigungu                  text                              법정동 시군구 5자리 코드
--  sigungu_nm               text                              시군구명        [SQL Editor 추가]
--  dong_nm                  text                              법정동명        [SQL Editor 추가]
--  address                  text                              도로명주소 (import 경유)
--  road_address             text                              (스키마에만 존재 · 미사용)
--  post_no                  text                              우편번호        [SQL Editor 추가]
--  lat                      double precision                  (스키마에만 존재 · 항상 NULL)
--  lng                      double precision                  (스키마에만 존재 · 항상 NULL)
--  phone                    text                              enrich 경유
--  capacity                 integer                           정원
--  current_count            integer                           현원 (enrich 경유)
--  eval_grade               text                              평가등급 A~E
--  eval_date                date                              평가일          [SQL Editor 추가]
--  established_at           date                              지정일자
--  monthly_fee              integer                           (스키마에만 · 미사용)
--  entry_fee                integer                           (스키마에만 · 미사용)
--  care_levels              text[]                            (스키마에만 · 미사용)
--  features                 text[]                            (스키마에만 · 미사용)
--  intro                    text                              (스키마에만 · 미사용)
--  is_partner               boolean             false         제휴시설 여부
--  raw                      jsonb                             ingest API 원본 (ingest 만 저장)
--  synced_at                timestamptz         now()
--  updated_at               timestamptz         now()
--  detail_synced_at         timestamptz                       상세보강 완료시각 [SQL Editor 추가]
--
--  인덱스 (db/schema.sql 기준 — 실제는 검증쿼리 2 로 확인):
--    facilities_pkey                (id)
--    idx_facilities_sido            (sido)
--    idx_facilities_sigungu         (sigungu)
--    idx_facilities_type            (type_code)
--    idx_facilities_grade           (eval_grade)
--    idx_facilities_vacancy         ((coalesce(capacity,0) - coalesce(current_count,0)))
--    idx_facilities_name            gin (to_tsvector('simple', name))
--    ⚠️ sigungu_nm / eval_date 에 대한 인덱스는 없을 가능성 높음 (검증 필요)
--
--  RLS: ENABLED, 정책 0개  →  service_role 만 접근 가능 (anon 전면 차단)


-- =====================================================================
-- TABLE: public.consultations   (무료 입소 상담 신청)
-- =====================================================================
--  id             bigint  generated always as identity  (PK)
--  created_at     timestamptz  NOT NULL  default now()
--  name           text  NOT NULL
--  phone          text  NOT NULL
--  relation       text
--  region         text
--  facility_type  text
--  care_level     text
--  budget         text
--  facility_name  text
--  memo           text
--  status         text  NOT NULL  default 'new'      -- new / contacted / done / spam
--  source_ip      text
--  user_agent     text
--
--  인덱스: consultations_pkey(id), idx_consultations_created(created_at desc),
--          idx_consultations_status(status)
--  RLS: ENABLED, 정책 0개


-- =====================================================================
-- TABLE: public.reviews   (이용자 리뷰 — 정의만 존재, 현재 미사용)
-- =====================================================================
--  id           bigint  generated always as identity  (PK)
--  facility_id  text  NOT NULL  REFERENCES public.facilities(id) ON DELETE CASCADE
--  created_at   timestamptz  NOT NULL  default now()
--  rating       smallint  NOT NULL  CHECK (rating between 1 and 5)
--  author       text
--  body         text
--  status       text  NOT NULL  default 'pending'    -- pending / published / hidden
--
--  인덱스: reviews_pkey(id), idx_reviews_facility(facility_id)
--  RLS: ENABLED, 정책 0개


-- =====================================================================
-- 없는 것 (1A 기준)
-- =====================================================================
--  · feature_flags, hospital_profiles, facility_evaluations, facility_sources,
--    facility_revisions, facility_duplicate_candidates, ingestion_runs  → 전부 없음
--  · facilities.domain / source / hira_ykiho / external_id              → 전부 없음
--  · 마이그레이션 관리 테이블(schema_migrations 등)                      → 없음
--  · 함수/트리거/뷰                                                     → 없음 (검증 필요)
