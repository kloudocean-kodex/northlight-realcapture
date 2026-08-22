create index if not exists task_comments_tenant_idx on public.task_comments(tenant_id);
create index if not exists task_comments_author_idx on public.task_comments(author_user_id);
create index if not exists task_issues_tenant_idx on public.task_issues(tenant_id);
create index if not exists task_issues_created_by_idx on public.task_issues(created_by_user_id);
create index if not exists task_issues_assigned_to_idx on public.task_issues(assigned_to_user_id);