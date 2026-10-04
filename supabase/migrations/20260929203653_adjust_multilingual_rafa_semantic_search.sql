do $$
declare
  lexical_definition text := pg_get_functiondef('public.rafa_search_knowledge(text,integer)'::regprocedure);
  hybrid_definition text := pg_get_functiondef('public.rafa_hybrid_search_knowledge(text,extensions.halfvec,text,integer)'::regprocedure);
begin
  execute replace(lexical_definition, '0.65', '0.75');
  execute replace(hybrid_definition, '0.65', '0.75');
end;
$$;
