\set ON_ERROR_STOP on

-- PostgreSQL DDL and data changes used by Northlight release migrations must
-- remain transactionally reversible before a release crosses an irreversible
-- external-provider boundary.
do $$
begin
  begin
    execute 'create table public.northlight_rollback_probe(id integer primary key)';
    execute 'insert into public.northlight_rollback_probe values (1)';
    raise exception 'intentional_rollback_probe';
  exception
    when others then
      if sqlerrm <> 'intentional_rollback_probe' then
        raise;
      end if;
  end;

  if pg_catalog.to_regclass('public.northlight_rollback_probe') is not null then
    raise exception 'rollback_contract: transactional DDL did not roll back';
  end if;
end
$$;
