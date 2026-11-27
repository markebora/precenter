-- PreCenter song database: every account sees and changes ONLY its own songs.
-- Paste this whole file in Supabase > SQL Editor > New query > Run. Safe to run again.

create table if not exists public.songs (
  gid        uuid not null,
  owner      uuid not null default auth.uid(),
  title      text not null,
  lyrics     text not null default '',
  data       jsonb not null default '{}'::jsonb,   -- the slide design and extra song details
  deleted    boolean not null default false,       -- songs are hidden, never erased
  updated_at timestamptz not null default now(),
  primary key (owner, gid)
);

-- upgrade a table made by the earlier (shared) version: the same song id may now exist once per account
do $$
begin
  if (select count(*) from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
      where i.indrelid = 'public.songs'::regclass and i.indisprimary) = 1 then
    if exists (select 1 from public.songs where owner is null) then
      raise exception 'Some songs have no owner. In Table Editor > songs, give them an owner or remove them, then run this again.';
    end if;
    alter table public.songs drop constraint songs_pkey;
    alter table public.songs alter column owner set not null;
    alter table public.songs add primary key (owner, gid);
  end if;
end $$;
create index if not exists songs_updated_idx on public.songs (owner, updated_at);

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

-- ---------- who may do what ----------
alter table public.songs enable row level security;

-- remove every earlier rule first (including the shared "anyone can read" one)
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'songs' loop
    execute format('drop policy %I on public.songs', p.policyname);
  end loop;
end $$;

create policy "read own songs" on public.songs for select to authenticated using (owner = auth.uid());
create policy "add own songs" on public.songs for insert to authenticated with check (owner = auth.uid());
create policy "change own songs" on public.songs for update to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());
-- no delete policy on purpose: PreCenter sets deleted = true instead

revoke all on public.songs from anon, authenticated;     -- people who are not signed in get nothing
grant select, insert, update on public.songs to authenticated;

-- ---------- limits for public use ----------
alter table public.songs drop constraint if exists songs_size;
alter table public.songs add constraint songs_size check (
  char_length(title) <= 300 and char_length(lyrics) <= 30000 and octet_length(data::text) <= 400000
) not valid;

-- one account can keep at most 2000 songs
create or replace function public.songs_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null
     and not exists (select 1 from public.songs where owner = auth.uid() and gid = new.gid)
     and (select count(*) from public.songs where owner = auth.uid()) >= 2000 then
    raise exception 'Song limit reached for this account';
  end if;
  return new;
end $$;
drop trigger if exists songs_guard on public.songs;
create trigger songs_guard before insert on public.songs
  for each row execute function public.songs_guard();
