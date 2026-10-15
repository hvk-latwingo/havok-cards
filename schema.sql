-- =====================================================================
--  Havok Cards — schéma Supabase (à coller dans SQL Editor, puis "Run")
--  Rôles : player (par défaut) · manager (gérant : cartes/boosters) · admin
-- =====================================================================

-- ---------- profils & rôles ------------------------------------------
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  role       text not null default 'player' check (role in ('player','manager','admin')),
  banned     boolean not null default false,
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles(id, email) values (new.id, new.email) on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- rattrape les comptes déjà existants
insert into public.profiles(id, email) select id, email from auth.users on conflict (id) do nothing;

create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select role from public.profiles where id = auth.uid() and not banned), 'player')
$$;
create or replace function public.is_admin()   returns boolean language sql stable security definer set search_path = public as $$ select public.my_role() = 'admin' $$;
create or replace function public.is_manager() returns boolean language sql stable security definer set search_path = public as $$ select public.my_role() in ('manager','admin') $$;
create or replace function public.not_banned() returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select not banned from public.profiles where id = auth.uid()), false)
$$;

-- ---------- données joueur -------------------------------------------
create table if not exists public.saves   (user_id uuid primary key references auth.users(id) on delete cascade, data jsonb not null default '{}', updated_at timestamptz not null default now());
create table if not exists public.players (user_id uuid primary key references auth.users(id) on delete cascade, data jsonb not null default '{}', score int not null default 0, updated_at timestamptz not null default now());
create table if not exists public.social  (user_id uuid primary key references auth.users(id) on delete cascade, data jsonb not null default '{}', updated_at timestamptz not null default now());
create index if not exists players_score_idx on public.players (score desc);

-- ---------- contenu géré par les gérants ------------------------------
create table if not exists public.cards (
  id         bigserial primary key,
  name       text not null check (char_length(name) between 1 and 40),
  rarity     int  not null check (rarity between 0 and 8),
  image_url  text not null,
  tag        text,
  atk        int,
  def        int,
  active     boolean not null default true,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
-- IMPORTANT : ne supprimez jamais une carte (désactivez-la) : l'ordre des identifiants sert de numéro de carte.

create table if not exists public.boosters (
  id           bigserial primary key,
  key          text unique not null check (key ~ '^[a-z0-9_-]{2,20}$'),
  name         text not null,
  description  text not null default '',
  ribbon_title text not null default 'BOOSTER',
  ribbon_sub   text not null default '5 CARTES',
  art_ids      int[]  not null default '{}',
  colors       text[] not null default '{}',
  pool_mode    text not null default 'ids' check (pool_mode in ('all','ids')),
  pool_ids     int[]  not null default '{}',
  active       boolean not null default true,
  sort         int not null default 100,
  starts_at    timestamptz,
  ends_at      timestamptz,
  created_by   uuid references auth.users(id),
  created_at   timestamptz not null default now()
);

create table if not exists public.settings (
  key        text primary key,
  value      jsonb not null,
  admin_only boolean not null default true
);
insert into public.settings(key, value, admin_only) values
  ('daily_boosters', '2', true),
  ('pack_prices', '[[1,60],[3,150],[10,450]]', true),
  ('weights', 'null', false),          -- poids de tirage par rareté (gérants)
  ('hidden_cards', '[]', false),       -- cartes intégrées masquées
  ('hidden_boosters', '[]', false)     -- boosters intégrés masqués (h, s, f)
on conflict (key) do nothing;

-- ---------- cadeaux & journal ----------------------------------------
create table if not exists public.grants (
  id         bigserial primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  pts        int not null default 0,
  bonus      int not null default 0,
  reason     text,
  claimed    boolean not null default false,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create or replace function public.guard_grants() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.is_admin() then return new; end if;
  if new.user_id <> old.user_id or new.pts <> old.pts or new.bonus <> old.bonus or new.claimed = false then
    raise exception 'modification non autorisée';
  end if;
  return new;
end $$;
drop trigger if exists grants_guard on public.grants;
create trigger grants_guard before update on public.grants for each row execute function public.guard_grants();

create table if not exists public.admin_log (
  id bigserial primary key, actor uuid references auth.users(id), action text not null, detail jsonb, created_at timestamptz not null default now()
);

-- ---------- sécurité (RLS) -------------------------------------------
alter table public.profiles  enable row level security;
alter table public.saves     enable row level security;
alter table public.players   enable row level security;
alter table public.social    enable row level security;
alter table public.cards     enable row level security;
alter table public.boosters  enable row level security;
alter table public.settings  enable row level security;
alter table public.grants    enable row level security;
alter table public.admin_log enable row level security;

drop policy if exists profiles_read on public.profiles;       create policy profiles_read on public.profiles for select to authenticated using (id = auth.uid() or public.is_admin());
drop policy if exists profiles_admin_upd on public.profiles;  create policy profiles_admin_upd on public.profiles for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- sauvegardes : privées (le joueur + l'admin en lecture)
drop policy if exists saves_own on public.saves;   create policy saves_own on public.saves for all to authenticated using (user_id = auth.uid() and public.not_banned()) with check (user_id = auth.uid() and public.not_banned());
drop policy if exists saves_admin_read on public.saves; create policy saves_admin_read on public.saves for select to authenticated using (public.is_admin());

-- profils publics (classement) et social : lisibles par tous les connectés
drop policy if exists players_read on public.players;  create policy players_read on public.players for select to authenticated using (true);
drop policy if exists players_own on public.players;   create policy players_own on public.players for all to authenticated using (user_id = auth.uid() and public.not_banned()) with check (user_id = auth.uid() and public.not_banned());
drop policy if exists players_admin on public.players; create policy players_admin on public.players for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists social_read on public.social;    create policy social_read on public.social for select to authenticated using (true);
drop policy if exists social_own on public.social;     create policy social_own on public.social for all to authenticated using (user_id = auth.uid() and public.not_banned()) with check (user_id = auth.uid() and public.not_banned());

-- contenu : lecture pour tous, écriture gérants/admin
drop policy if exists cards_read on public.cards;      create policy cards_read on public.cards for select using (true);
drop policy if exists cards_write on public.cards;     create policy cards_write on public.cards for all to authenticated using (public.is_manager()) with check (public.is_manager());
drop policy if exists boosters_read on public.boosters;  create policy boosters_read on public.boosters for select using (true);
drop policy if exists boosters_write on public.boosters; create policy boosters_write on public.boosters for all to authenticated using (public.is_manager()) with check (public.is_manager());
drop policy if exists settings_read on public.settings;  create policy settings_read on public.settings for select using (true);
drop policy if exists settings_write on public.settings; create policy settings_write on public.settings for all to authenticated
  using (public.is_admin() or (public.is_manager() and not admin_only)) with check (public.is_admin() or (public.is_manager() and not admin_only));

-- cadeaux : l'admin crée, le joueur lit/valide les siens
drop policy if exists grants_read on public.grants;   create policy grants_read on public.grants for select to authenticated using (user_id = auth.uid() or public.is_admin());
drop policy if exists grants_admin on public.grants;  create policy grants_admin on public.grants for insert to authenticated with check (public.is_admin());
drop policy if exists grants_claim on public.grants;  create policy grants_claim on public.grants for update to authenticated using (user_id = auth.uid() or public.is_admin()) with check (user_id = auth.uid() or public.is_admin());

-- journal : gérants/admin écrivent, admin lit
drop policy if exists log_write on public.admin_log; create policy log_write on public.admin_log for insert to authenticated with check (public.is_manager());
drop policy if exists log_read on public.admin_log;  create policy log_read on public.admin_log for select to authenticated using (public.is_admin());

-- ---------- duels en direct -------------------------------------------
create table if not exists public.duels (
  id         uuid primary key default gen_random_uuid(),
  host       uuid not null references auth.users(id) on delete cascade,
  guest      uuid references auth.users(id) on delete set null,
  host_name  text not null default '',
  guest_name text,
  status     text not null default 'open' check (status in ('open','playing','done','cancelled')),
  rev        integer not null default 0,
  state      jsonb not null default '{}'::jsonb,
  winner     uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists duels_status_idx on public.duels (status, created_at desc);
alter table public.duels enable row level security;

-- on ne peut ni changer l'hôte, ni remplacer l'invité une fois le duel lancé
create or replace function public.guard_duels() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.host is distinct from old.host then raise exception 'hote non modifiable'; end if;
  if old.guest is not null and new.guest is distinct from old.guest then raise exception 'invite non modifiable'; end if;
  return new;
end $$;
drop trigger if exists duels_guard on public.duels;
create trigger duels_guard before update on public.duels for each row execute function public.guard_duels();

drop policy if exists duels_read on public.duels;  create policy duels_read on public.duels for select to authenticated
  using (status = 'open' or host = auth.uid() or guest = auth.uid());
drop policy if exists duels_ins on public.duels;   create policy duels_ins on public.duels for insert to authenticated
  with check (host = auth.uid() and guest is null and status = 'open' and public.not_banned());
drop policy if exists duels_upd on public.duels;   create policy duels_upd on public.duels for update to authenticated
  using (public.not_banned() and (host = auth.uid() or guest = auth.uid() or (status = 'open' and guest is null)))
  with check (host = auth.uid() or guest = auth.uid());
drop policy if exists duels_del on public.duels;   create policy duels_del on public.duels for delete to authenticated
  using (host = auth.uid() or guest = auth.uid() or public.is_admin());

-- ---------- temps réel -----------------------------------------------
do $$ begin
  begin alter publication supabase_realtime add table public.players; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.social;  exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.cards;   exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.boosters; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.settings; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.duels;    exception when duplicate_object then null; end;
end $$;

-- ---------- images des cartes (Storage) -------------------------------
insert into storage.buckets (id, name, public) values ('cards', 'cards', true) on conflict (id) do nothing;
drop policy if exists cards_img_read on storage.objects;   create policy cards_img_read on storage.objects for select using (bucket_id = 'cards');
drop policy if exists cards_img_ins on storage.objects;    create policy cards_img_ins on storage.objects for insert to authenticated with check (bucket_id = 'cards' and public.is_manager());
drop policy if exists cards_img_upd on storage.objects;    create policy cards_img_upd on storage.objects for update to authenticated using (bucket_id = 'cards' and public.is_manager());
drop policy if exists cards_img_del on storage.objects;    create policy cards_img_del on storage.objects for delete to authenticated using (bucket_id = 'cards' and public.is_manager());

-- ---------- PREMIER ADMIN ---------------------------------------------
-- 1) créez votre compte dans l'application  2) remplacez l'e-mail ci-dessous et exécutez :
-- update public.profiles set role = 'admin' where email = 'vous@exemple.com';
