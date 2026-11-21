create or replace function public.find_auth_account(p_email text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select case when count(*) = 1 then (array_agg(candidate.id))[1] end
  from (
    select id from auth.users
    where lower(email) = lower(btrim(p_email))
    limit 2
  ) as candidate;
$$;

create table if not exists public.password_recovery_tokens (
  token_hash text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  email text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz
);
create index if not exists password_recovery_pending_user
  on public.password_recovery_tokens (user_id) where consumed_at is null;
alter table public.password_recovery_tokens enable row level security;
revoke all on public.password_recovery_tokens from public, anon, authenticated;
grant insert on public.password_recovery_tokens to service_role;

-- Preserve recovery links already sent by the previous backend.
insert into public.password_recovery_tokens (token_hash, user_id, email, expires_at)
select encode(sha256(convert_to(token::text, 'UTF8')), 'hex'), account.id, lower(email), expires_at
from public.company_invitations
cross join lateral (select public.find_auth_account(email) as id) as account
where role = 'password_reset' and status = 'pending' and expires_at > clock_timestamp()
  and token is not null and account.id is not null
on conflict (token_hash) do nothing;

update public.company_invitations set status = 'cancelled'
where role = 'password_reset' and status = 'pending';

create or replace function public.claim_password_recovery(p_token uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_user uuid;
  requested_hash text := encode(sha256(convert_to(p_token::text, 'UTF8')), 'hex');
begin
  select user_id into target_user
  from public.password_recovery_tokens
  where token_hash = requested_hash and consumed_at is null and expires_at > clock_timestamp();
  if not found then
    return null;
  end if;

  -- Serialize claims for the same account, even when using different links.
  perform pg_advisory_xact_lock(hashtextextended(target_user::text, 104197));

  update public.password_recovery_tokens
  set consumed_at = clock_timestamp()
  where token_hash = requested_hash and consumed_at is null and expires_at > clock_timestamp()
    and exists (select 1 from auth.users where id = target_user
      and lower(users.email) = password_recovery_tokens.email);
  if not found then
    return null;
  end if;

  update public.password_recovery_tokens
  set consumed_at = clock_timestamp()
  where user_id = target_user and consumed_at is null;
  return target_user;
end;
$$;

revoke execute on function public.find_auth_account(text) from public, anon, authenticated;
revoke execute on function public.claim_password_recovery(uuid) from public, anon, authenticated;
grant execute on function public.find_auth_account(text) to service_role;
grant execute on function public.claim_password_recovery(uuid) to service_role;

-- Acceptance is now handled by the API, which verifies the invited account.
do $$
declare
  legacy_function regprocedure;
begin
  for legacy_function in
    select p.oid::regprocedure from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'accept_company_invitation'
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', legacy_function);
  end loop;
end;
$$;
