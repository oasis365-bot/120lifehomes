-- =====================================================================
-- Migration 006 — 전국 요양병원 수집 checkpoint/lease/일일 쿼터 스키마 (1B-5B)
-- 방향: DOWN (되돌리기, 최후 수단)
-- =====================================================================
--  이 migration 은 데이터를 만들지 않으므로(순수 스키마+함수) 롤백해도
--  facilities/LTC/요양병원 3건 시험 데이터는 전혀 영향받지 않는다.
--  이 파일이 만든 객체(테이블 3개, 함수 4개, 인덱스·제약)만 역순으로 제거한다.
-- =====================================================================

begin;

-- 함수 (up 에서 만든 4개만)
drop function if exists public.hospital_hira_reserve_daily_calls(integer, integer);
drop function if exists public.hospital_collection_job_release_lease(uuid, text, text);
drop function if exists public.hospital_collection_job_heartbeat(uuid, text, integer);
drop function if exists public.hospital_collection_job_acquire_lease(uuid, text, integer);

-- 테이블 (CASCADE 로 인덱스·제약·FK 도 함께 제거됨. hospital_collection_items 가
-- hospital_collection_jobs 를 참조하므로 items 먼저)
drop table if exists public.hospital_collection_items  cascade;
drop table if exists public.hospital_collection_jobs   cascade;
drop table if exists public.hospital_hira_daily_usage  cascade;

-- 마이그레이션 기록 제거
delete from public.schema_migrations where version = '006_hospital_collection';

commit;
