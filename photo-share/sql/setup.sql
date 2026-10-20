-- 写真共有（練習版） v1  Supabase 設定SQL（計画書 §6）
-- 利用者が SQL Editor で実行する。何度実行しても同じ結果になる書き方にしている。
-- 会社のメールドメインはこのファイルに書かない。実行後に README の手順で app_settings へ1行だけ入れる。
-- 保存期間 30日 は interval '30 days' の4か所（photos_select / list_expired / delete_expired / Storage の削除ポリシー）。
-- スキーマ名 photo_share・バケット名 photo-share は app.js 冒頭の定数と合わせる。

-- ============================================================
-- 6.1 スキーマ
-- ============================================================
create schema if not exists photo_share;
revoke all on schema photo_share from public, anon;
grant usage on schema photo_share to authenticated;

-- ============================================================
-- 5.3 設定テーブル（許可ドメイン）。誰にもGRANTしない（判定関数だけが読む）
-- ============================================================
create table if not exists photo_share.app_settings (
  key   text primary key,
  value text not null
);
alter table photo_share.app_settings enable row level security;
revoke all on table photo_share.app_settings from public, anon, authenticated;

-- ============================================================
-- 5.2 写真テーブル
-- ============================================================
create table if not exists photo_share.photos (
  id             uuid primary key default gen_random_uuid(),
  storage_path   text not null unique check (storage_path ~ '^p/[0-9a-f-]{36}\.jpg$'),
  thumb_path     text not null unique check (thumb_path ~ '^t/[0-9a-f-]{36}\.jpg$'),
  uploader_email text not null default lower(auth.jwt() ->> 'email'),
  memo           text check (memo is null or char_length(memo) <= 200),
  created_at     timestamptz not null default now()
);
create index if not exists photos_created_at_idx on photo_share.photos (created_at desc);

-- ============================================================
-- 6.2 判定関数：ログイン中のメールが「@許可ドメイン」で終わるか
--   LIKE を使わず right() と長さで比べる（sub.ドメイン／ドメイン.example を通さない）
--   設定が無い・空、メールが無い（匿名ログイン等）ときは false
-- ============================================================
create or replace function photo_share.is_allowed_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select length(trim(s.value)) > 0
       and length(lower(coalesce(auth.jwt() ->> 'email', ''))) > length(trim(s.value)) + 1
       and right(lower(coalesce(auth.jwt() ->> 'email', '')), length(trim(s.value)) + 1)
           = '@' || lower(trim(s.value))
    from photo_share.app_settings s
    where s.key = 'allowed_email_domain'
  ), false);
$$;
revoke all on function photo_share.is_allowed_user() from public, anon;
grant execute on function photo_share.is_allowed_user() to authenticated;

-- ============================================================
-- 6.3 photos の RLS と GRANT
-- ============================================================
alter table photo_share.photos enable row level security;

-- 付け直しのため、いったん全部外してから必要な分だけ付ける
revoke all on table photo_share.photos from public, anon, authenticated;
grant select on table photo_share.photos to authenticated;
grant insert (storage_path, thumb_path, memo) on table photo_share.photos to authenticated; -- 列単位
-- UPDATE・DELETE は GRANT しない（片付けは 6.5 の関数経由）

drop policy if exists photos_select on photo_share.photos;
create policy photos_select on photo_share.photos
  for select to authenticated
  using (photo_share.is_allowed_user() and created_at > now() - interval '30 days');

drop policy if exists photos_insert on photo_share.photos;
create policy photos_insert on photo_share.photos
  for insert to authenticated
  with check (
    photo_share.is_allowed_user()
    and uploader_email = lower(auth.jwt() ->> 'email')
    and storage_path like 'p/%'
    and thumb_path like 't/%'
  );

-- ============================================================
-- 6.5 期限切れの片付け用の関数（photos の SELECT では期限切れ行が見えないため）
-- ============================================================
create or replace function photo_share.list_expired(max_rows integer default 100)
returns table (id uuid, storage_path text, thumb_path text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not photo_share.is_allowed_user() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return query
    select p.id, p.storage_path, p.thumb_path
    from photo_share.photos p
    where p.created_at <= now() - interval '30 days'
    order by p.created_at
    limit least(greatest(coalesce(max_rows, 100), 1), 1000);
end;
$$;
revoke all on function photo_share.list_expired(integer) from public, anon;
grant execute on function photo_share.list_expired(integer) to authenticated;

create or replace function photo_share.delete_expired(ids uuid[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  if not photo_share.is_allowed_user() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  -- 期限切れを再確認してから消す（30日以内の行は ids に入れても消えない）
  delete from photo_share.photos p
  where p.id = any(ids)
    and p.created_at <= now() - interval '30 days';
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function photo_share.delete_expired(uuid[]) from public, anon;
grant execute on function photo_share.delete_expired(uuid[]) to authenticated;

-- ============================================================
-- 5.4 Storage バケット（非公開・10MB・JPEGのみ）
--   2回目以降の実行でも非公開・上限・形式がこの値にそろうよう、既存なら上書きする
-- ============================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photo-share', 'photo-share', false, 10485760, array['image/jpeg'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ============================================================
-- 6.4 Storage（storage.objects）のポリシー
--   storage.objects の RLS は Supabase が最初から有効にしている（ここでは変更しない）
-- ============================================================
drop policy if exists photo_share_objects_select on storage.objects;
create policy photo_share_objects_select on storage.objects
  for select to authenticated
  using (bucket_id = 'photo-share' and photo_share.is_allowed_user());
  -- 削除APIが読む権限も要るため、ここには30日条件を付けない（U-14：実環境で確認）

drop policy if exists photo_share_objects_insert on storage.objects;
create policy photo_share_objects_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'photo-share'
    and photo_share.is_allowed_user()
    and (name like 'p/%' or name like 't/%')
  );

-- UPDATE のポリシーは作らない（上書き禁止）

drop policy if exists photo_share_objects_delete on storage.objects;
create policy photo_share_objects_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'photo-share'
    and photo_share.is_allowed_user()
    and created_at <= now() - interval '30 days'
  );

-- ============================================================
-- 実行後に利用者が1回だけ行うこと（README 参照）
--   insert into photo_share.app_settings (key, value)
--   values ('allowed_email_domain', '<会社のメールドメイン>')
--   on conflict (key) do update set value = excluded.value;
-- ============================================================
