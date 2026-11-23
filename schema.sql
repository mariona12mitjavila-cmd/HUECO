-- Plazas: esquema para Supabase. Pégalo entero en SQL Editor > New query > Run.
-- Todo es anónimo: no hay cuentas. Cada navegador genera un identificador aleatorio ("device").

create extension if not exists pgcrypto;

-- 1) Avisos: «me voy» (leaving) y «he aparcado» (parked)
create table if not exists public.reports (
  id          uuid primary key,
  street      text not null check (char_length(street) between 1 and 80),
  street_name text not null check (char_length(street_name) between 1 and 80),
  event       text not null check (event in ('leaving','parked')),
  eta_min     integer check (eta_min between 0 and 720),
  device      text not null check (char_length(device) between 8 and 64),
  cancelled   boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists reports_created_idx on public.reports (created_at desc);
create index if not exists reports_street_idx on public.reports (street, created_at desc);

-- 2) Votos: confirmar o desmentir un aviso (un voto por dispositivo y aviso)
create table if not exists public.votes (
  report_id  uuid not null references public.reports(id) on delete cascade,
  device     text not null check (char_length(device) between 8 and 64),
  vote       smallint not null check (vote in (-1, 1)),
  created_at timestamptz not null default now(),
  primary key (report_id, device)
);

-- 3) Seguridad: nadie puede LEER las tablas directamente (así no se ve el identificador de dispositivo).
alter table public.reports enable row level security;
alter table public.votes   enable row level security;

drop policy if exists "insertar avisos" on public.reports;
create policy "insertar avisos" on public.reports
  for insert to anon
  with check (cancelled = false and created_at > now() - interval '1 minute');

drop policy if exists "insertar votos" on public.votes;
create policy "insertar votos" on public.votes
  for insert to anon
  with check (true);

-- 4) Vista pública: solo avisos de las últimas 12 horas, sin identificador de dispositivo, con los votos contados.
--    (Una vista se ejecuta con los permisos de su creador, por eso anon puede leerla aunque no lea las tablas.)
create or replace view public.reports_public as
select
  r.id, r.street, r.street_name, r.event, r.eta_min, r.created_at,
  coalesce((select count(*) from public.votes v where v.report_id = r.id and v.vote =  1), 0)::int as confirms,
  coalesce((select count(*) from public.votes v where v.report_id = r.id and v.vote = -1), 0)::int as denies
from public.reports r
where r.cancelled = false
  and r.created_at > now() - interval '12 hours';

grant select on public.reports_public to anon;
grant insert on public.reports to anon;
grant insert on public.votes to anon;

-- 5) Cancelar tu propio aviso (solo si el dispositivo coincide)
create or replace function public.cancel_report(p_id uuid, p_device text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.reports set cancelled = true where id = p_id and device = p_device;
$$;
grant execute on function public.cancel_report(uuid, text) to anon;

-- 6) Limpieza: borra avisos de más de 2 días. Ejecuta esta línea de vez en cuando
--    o prográmala en Database > Cron (extensión pg_cron).
-- delete from public.reports where created_at < now() - interval '2 days';
