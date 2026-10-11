-- PML Snagging database tables (PlanetScale Postgres).
-- The API creates these itself if its login is allowed to. If its login is read/write only, run this
-- once in PlanetScale first. Same as SCHEMA in lib/store-postgres.js — keep them the same.
create sequence if not exists rev_seq;
create table if not exists users (
  email text primary key,
  data jsonb not null default '{}',
  rev bigint not null default nextval('rev_seq'),
  deleted boolean not null default false);
create table if not exists settings (
  id text primary key,
  data jsonb not null default '{}',
  rev bigint not null default nextval('rev_seq'),
  deleted boolean not null default false);
create table if not exists jobs (
  id text primary key,
  contractor_emails text[] not null default '{}',
  data jsonb not null default '{}',
  rev bigint not null default nextval('rev_seq'),
  deleted boolean not null default false);
create table if not exists drawings (
  job_id text not null,
  id text not null,
  data jsonb not null default '{}',
  rev bigint not null default nextval('rev_seq'),
  deleted boolean not null default false,
  primary key (job_id, id));
create table if not exists drawing_chunks (
  job_id text not null,
  drawing_id text not null,
  id text not null,
  i integer not null default 0,
  d text not null default '',
  data jsonb not null default '{}',
  primary key (job_id, drawing_id, id));
create table if not exists snags (
  job_id text not null,
  id text not null,
  contractor_emails text[] not null default '{}',
  status text not null default '',
  data jsonb not null default '{}',
  rev bigint not null default nextval('rev_seq'),
  deleted boolean not null default false,
  primary key (job_id, id));
create table if not exists photos (
  job_id text not null,
  snag_id text not null,
  id text not null,
  by_email text not null default '',
  kind text not null default '',
  at bigint not null default 0,
  d text not null default '',
  data jsonb not null default '{}',
  primary key (job_id, snag_id, id));
create index if not exists users_rev on users (rev);
create index if not exists settings_rev on settings (rev);
create index if not exists jobs_rev on jobs (rev);
create index if not exists jobs_contractors on jobs using gin (contractor_emails);
create index if not exists drawings_rev on drawings (rev);
create index if not exists snags_rev on snags (rev);
create index if not exists snags_contractors on snags using gin (contractor_emails);
