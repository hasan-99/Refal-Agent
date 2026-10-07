alter table public.rafa_agent_sessions alter column model set default 'openai/gpt-6-luna';
update public.rafa_agent_sessions set model = 'openai/gpt-6-luna' where model is distinct from 'openai/gpt-6-luna';
