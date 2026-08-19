alter table public.media_upload_sessions add column if not exists client_fingerprint text;

alter table public.media_upload_sessions drop constraint if exists media_upload_sessions_status_check;
alter table public.media_upload_sessions add constraint media_upload_sessions_status_check
  check (status in ('uploading','uploaded','done','failed'));

create index if not exists media_upload_sessions_resume_idx
  on public.media_upload_sessions (user_id,task_id,status,expires_at desc);
