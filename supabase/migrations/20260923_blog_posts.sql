-- Módulo: Blog, Artículos y Publicaciones
-- Permite publicar artículos en la web pública y gestionarlos desde el panel de administración.

create table if not exists blog_posts (
  id                    uuid primary key default gen_random_uuid(),
  title                 text not null,
  slug                  text not null unique,
  excerpt               text,
  content               text not null,
  cover_image           text,
  category              text not null default 'Finanzas',
  tags                  text[] default '{}',
  author_name           text not null default 'Equipo Finto',
  author_role           text default 'Finanzas & Estrategia',
  reading_time_minutes  integer not null default 5,
  published             boolean not null default false,
  featured              boolean not null default false,
  published_at          timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists blog_posts_slug_idx        on blog_posts (slug);
create index if not exists blog_posts_published_idx   on blog_posts (published);
create index if not exists blog_posts_category_idx    on blog_posts (category);
create index if not exists blog_posts_created_at_idx  on blog_posts (created_at desc);

-- RLS
alter table blog_posts enable row level security;

-- Tabla de categorías de blog
create table if not exists blog_categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  slug        text not null unique,
  description text,
  color       text default 'brand',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists blog_categories_slug_idx on blog_categories (slug);

alter table blog_categories enable row level security;

drop policy if exists "Categorías son públicas para lectura" on blog_categories;
create policy "Categorías son públicas para lectura"
  on blog_categories for select
  using (true);

