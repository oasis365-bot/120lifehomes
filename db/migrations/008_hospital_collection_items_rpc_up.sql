-- Preview 전국 요양병원 discovery item 저장 전용 RPC.
-- table REST bulk insert 대신 service_role만 실행 가능한 SECURITY DEFINER 함수에서
-- 작은 멱등 chunk를 처리한다. 기관 원문/raw/비밀값은 이 함수에 전달하거나 저장하지 않는다.

create or replace function public.hospital_collection_insert_discovery_items(
  p_job_id uuid,
  p_rows jsonb
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  if p_job_id is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'invalid discovery item batch';
  end if;

  v_count := jsonb_array_length(p_rows);
  if v_count < 1 or v_count > 25 then
    raise exception 'invalid discovery item batch size';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_rows) as row_data
    where jsonb_typeof(row_data) <> 'object'
       or not (row_data ? 'ordinal' and row_data ? 'facility_id')
  ) then
    raise exception 'invalid discovery item row';
  end if;

  insert into public.hospital_collection_items (job_id, ordinal, facility_id, status)
  select
    p_job_id,
    (row_data->>'ordinal')::integer,
    row_data->>'facility_id',
    'pending'
  from jsonb_array_elements(p_rows) as row_data
  on conflict do nothing;

  return true;
end;
$$;

revoke all on function public.hospital_collection_insert_discovery_items(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.hospital_collection_insert_discovery_items(uuid, jsonb) to service_role;
