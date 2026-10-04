alter table public.rafa_agent_sessions
  alter column model set default 'inclusionai/ling-3.0-flash-sante:free';

update public.rafa_agent_sessions
   set model = 'inclusionai/ling-3.0-flash-sante:free',
       updated_at = now()
 where model in (
   'openrouter/free',
   'nvidia/nemotron-3-ultra-550b-a55b:free'
 );
