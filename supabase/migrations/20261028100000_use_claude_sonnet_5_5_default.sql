-- Default chat model: Claude Sonnet 5.5 (GPT-6 Luna stays the worker fallback).
-- Matches src/openrouterPrivacy.js and the rafa-agent-api defaultChatModel.
-- Only sessions still on the previous default move; an operator's explicit
-- choice of any other model is left alone.
-- Rollback:
--   alter table public.rafa_agent_sessions alter column model set default 'openai/gpt-6-luna';
alter table public.rafa_agent_sessions alter column model set default 'anthropic/claude-sonnet-5.5';
update public.rafa_agent_sessions set model = 'anthropic/claude-sonnet-5.5' where model = 'openai/gpt-6-luna';
