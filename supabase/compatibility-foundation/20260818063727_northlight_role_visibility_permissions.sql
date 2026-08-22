update public.roles set permissions='["all_tasks","create_task","assign","manage_users","manage_roles","manage_integrations","review","upload","reports","view_raw","view_edited","view_final","view_finance","manage_finance"]'::jsonb where code='admin';
update public.roles set permissions='["all_tasks","reports","review","team","view_raw","view_edited","view_final","view_finance","manage_finance"]'::jsonb where code='owner';
update public.roles set permissions='["own_tasks","create_task","assign","review","reschedule","cancel","view_final"]'::jsonb where code='agent';
update public.roles set permissions='["assigned_tasks","confirm","decline","reschedule","upload_source","view_raw","view_final"]'::jsonb where code='photographer';
update public.roles set permissions='["editing_queue","upload_edit","revision","view_raw","view_edited"]'::jsonb where code='editor';
