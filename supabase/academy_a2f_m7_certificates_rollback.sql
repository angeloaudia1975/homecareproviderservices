-- HCPS Academy — A2F / M7 ROLLBACK (DEVELOPMENT; NOT run). Removes the six academy_cert_ functions and gives the
-- server role back EXECUTE on M1's issue / revoke (the state before M7). Refused while any HCPS certificate exists:
-- once a certificate has been issued through M7, removing the only revocation path is not a rollback but a change of
-- policy, and needs its own approved step. M1's own code is never touched.
begin;
do $$ begin
  if to_regprocedure('public.academy_cert_op_claim(text,uuid)') is null then raise exception 'M7 is not installed'; end if;
  if exists (select 1 from academy_certificates) then
    raise exception 'M7 rollback refused: HCPS certificates exist. Revocation would lose its President-only path.';
  end if;
end $$;
drop function public.academy_cert_op_verify(text);
drop function public.academy_cert_op_revoke(text, uuid, text);
drop function public.academy_cert_op_claim(text, uuid);
drop function public.academy_cert_view(academy_certificates);
drop function public.academy_cert_president(text);
grant execute on function public.academy_op_issue_certificate(text, uuid, text) to service_role;
grant execute on function public.academy_op_revoke_certificate(text, uuid, text) to service_role;
grant insert, update, delete on table public.academy_certificates to service_role;
select 'M7 removed' as check, to_regprocedure('public.academy_cert_op_claim(text,uuid)') is null
   and has_function_privilege('service_role', 'public.academy_op_issue_certificate(text,uuid,text)', 'execute') as ok;
commit;
