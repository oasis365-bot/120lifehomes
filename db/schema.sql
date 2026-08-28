-- =====================================================================
-- 120 라이프홈즈 — Supabase(PostgreSQL) 스키마
-- Supabase 대시보드 → SQL Editor 에 붙여넣고 실행하세요.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. 요양시설  (공공데이터포털 장기요양기관 데이터 + 제휴 시설 보강정보)
-- ---------------------------------------------------------------------
create table if not exists public.facilities (
  id              text primary key,               -- 장기요양기관기호
  name            text not null,
  type_code       text,                            -- 급여종류 코드
  type_label      text,                            -- 급여종류 한글 (노인요양시설 등)
  sido            text,                            -- 시도
  sigungu         text,                            -- 시군구
  address         text,                            -- 지번주소
  road_address    text,                            -- 도로명주소
  lat             double precision,
  lng             double precision,
  phone           text,
  capacity        integer,                         -- 정원
  current_count   integer,                         -- 현원
  eval_grade      text,                            -- 평가등급 (A~E)
  established_at  date,                            -- 지정일자

  -- 제휴 시설이 직접 채우는 보강 정보 (공공데이터에 없음)
  monthly_fee     integer,                         -- 월 이용료(만원, 예상)
  entry_fee       integer,                         -- 입소보증금(만원)
  care_levels     text[],                          -- 수용 가능 장기요양등급
  features        text[],                          -- 편의·특징 태그
  intro           text,                            -- 시설 소개
  is_partner      boolean not null default false,  -- 제휴 시설 여부

  raw             jsonb,                           -- 공공 API 원본 레코드
  synced_at       timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- 공실(정원-현원)로 자주 정렬/필터하므로 함수 인덱스
create index if not exists idx_facilities_sido    on public.facilities (sido);
create index if not exists idx_facilities_sigungu on public.facilities (sigungu);
create index if not exists idx_facilities_type    on public.facilities (type_code);
create index if not exists idx_facilities_grade   on public.facilities (eval_grade);
create index if not exists idx_facilities_vacancy on public.facilities ((coalesce(capacity,0) - coalesce(current_count,0)));
create index if not exists idx_facilities_name    on public.facilities using gin (to_tsvector('simple', name));

-- ---------------------------------------------------------------------
-- 2. 무료 입소 상담 신청
-- ---------------------------------------------------------------------
create table if not exists public.consultations (
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  name          text not null,
  phone         text not null,
  relation      text,
  region        text,
  facility_type text,
  care_level    text,
  budget        text,
  facility_name text,
  memo          text,
  status        text not null default 'new',       -- new / contacted / done / spam
  source_ip     text,
  user_agent    text
);
create index if not exists idx_consultations_created on public.consultations (created_at desc);
create index if not exists idx_consultations_status  on public.consultations (status);

-- ---------------------------------------------------------------------
-- 3. 이용자 리뷰 (추후 사용)
-- ---------------------------------------------------------------------
create table if not exists public.reviews (
  id           bigint generated always as identity primary key,
  facility_id  text not null references public.facilities(id) on delete cascade,
  created_at   timestamptz not null default now(),
  rating       smallint not null check (rating between 1 and 5),
  author       text,
  body         text,
  status       text not null default 'pending'     -- pending / published / hidden
);
create index if not exists idx_reviews_facility on public.reviews (facility_id);

-- ---------------------------------------------------------------------
-- 4. RLS  — 모든 접근은 서버(API 함수, service_role)를 통해서만.
--    anon/public 키로는 어떤 테이블도 직접 읽거나 쓸 수 없습니다.
-- ---------------------------------------------------------------------
alter table public.facilities    enable row level security;
alter table public.consultations enable row level security;
alter table public.reviews       enable row level security;
-- (정책을 만들지 않으므로 service_role 외 전부 차단됨)
