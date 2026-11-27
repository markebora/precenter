-- PreCenter song database. Paste this whole file in Supabase > SQL Editor > New query > Run. Safe to run again.

create table if not exists public.songs (
  gid        uuid primary key,
  owner      uuid default auth.uid(),
  title      text not null,
  lyrics     text not null default '',
  data       jsonb not null default '{}'::jsonb,   -- the slide design and extra song details
  deleted    boolean not null default false,       -- songs are hidden, never erased
  updated_at timestamptz not null default now()
);
create index if not exists songs_updated_idx on public.songs (updated_at);

-- every insert or update stamps the time, so PreCenter can ask "what changed since last time?"
create or replace function public.songs_touch() returns trigger language plpgsql as $$
begin
  new.updated_at := clock_timestamp();
  if tg_op = 'INSERT' then new.owner := coalesce(new.owner, auth.uid()); end if;
  return new;
end $$;
drop trigger if exists songs_touch on public.songs;
create trigger songs_touch before insert or update on public.songs
  for each row execute function public.songs_touch();

alter table public.songs enable row level security;

drop policy if exists "anyone can read songs" on public.songs;
create policy "anyone can read songs" on public.songs for select to anon, authenticated using (true);

drop policy if exists "signed-in users add songs" on public.songs;
create policy "signed-in users add songs" on public.songs for insert to authenticated with check (owner = auth.uid());

drop policy if exists "owners change their songs" on public.songs;
create policy "owners change their songs" on public.songs for update to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());
-- no delete policy on purpose: PreCenter sets deleted = true instead

grant select on public.songs to anon, authenticated;
grant insert, update on public.songs to authenticated;

-- ---------- limits for public use ----------
-- size limits (checked for new and changed songs)
alter table public.songs drop constraint if exists songs_size;
alter table public.songs add constraint songs_size check (
  char_length(title) <= 300 and char_length(lyrics) <= 30000 and octet_length(data::text) <= 400000
) not valid;

-- a song keeps its first owner, and one account can add at most 2000 songs
create or replace function public.songs_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    new.owner := old.owner;
  elsif auth.uid() is not null
        and not exists (select 1 from public.songs where gid = new.gid)
        and (select count(*) from public.songs where owner = auth.uid()) >= 2000 then
    raise exception 'Song limit reached for this account';
  end if;
  return new;
end $$;
drop trigger if exists songs_guard on public.songs;
create trigger songs_guard before insert or update on public.songs
  for each row execute function public.songs_guard();
create index if not exists songs_owner_idx on public.songs (owner);

-- OPTIONAL: let your own Google emails edit every song (replace the emails, then run this part too)
-- drop policy if exists "admins change all songs" on public.songs;
-- create policy "admins change all songs" on public.songs for update to authenticated
--   using ((auth.jwt() ->> 'email') in ('you@gmail.com','teammate@gmail.com'))
--   with check (true);
