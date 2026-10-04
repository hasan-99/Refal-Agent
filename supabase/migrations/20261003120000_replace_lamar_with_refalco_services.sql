create or replace function public.rafa_apply_knowledge_approval_lifecycle()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare v_apply_approval boolean := false;
begin
  if new.review_status = 'approved' then
    if tg_op = 'INSERT' then v_apply_approval := true;
    elsif old.review_status is distinct from 'approved' or new.approved_at is distinct from old.approved_at then v_apply_approval := true;
    end if;
  end if;
  if v_apply_approval then
    perform 1 from public.rafa_knowledge_sources s where s.id = new.source_id for update;
    update public.rafa_knowledge_documents d set review_status = 'superseded', approved_at = null, approved_by = null
      where d.source_id = new.source_id and d.id is distinct from new.id and d.review_status = 'approved';
    if new.canonical_content ~* '(?:[$€£][[:space:]]*[0-9٠-٩]|(?:EUR|USD|GBP)[[:space:]]*[0-9٠-٩]|[0-9٠-٩][0-9٠-٩.,[:space:]]*(?:EUR|USD|GBP|euros?|dollars?|pounds?|يورو|دولار|جنيه|ευρώ))' then
      if new.valid_until is null or new.valid_until <= now() then new.valid_until := now() + interval '30 days';
      else new.valid_until := least(new.valid_until, now() + interval '30 days'); end if;
    end if;
  end if;
  return new;
end;
$$;begin;

delete from public.rafa_knowledge_sources
where lower(canonical_url) like '%lamar%'
   or lower(display_name) like '%lamar%';

insert into public.rafa_knowledge_sources
  (canonical_url, display_name, source_kind, trust_tier, enabled, approved, approval_note, metadata)
values
  ('https://refalco.com/services/', 'REFALCO GROUP Services', 'first_party_website', 'first_party', true, true,
   'Only the approved bilingual company-formation summary is retrievable; fetched page content requires review.',
   '{"research_status":"pending_review","retrieved_on":"2026-10-03","approved_scope":"company_formation_summary_only"}'::jsonb)
on conflict (canonical_url) do update
set display_name = excluded.display_name,
    source_kind = excluded.source_kind,
    trust_tier = excluded.trust_tier,
    enabled = true,
    approved = true,
    approval_note = excluded.approval_note,
    last_status = 'ready',
    metadata = excluded.metadata,
    updated_at = now();

insert into public.rafa_knowledge_sources
  (canonical_url, display_name, source_kind, trust_tier, enabled, approved, approval_note, metadata)
values
  ('manual://owner-confirmed/refalco-group-structure', 'Owner-confirmed REFALCO services transition', 'manual', 'operator_supplied', true, true,
   'Owner-confirmed service transition; keep verification provenance internal.',
   '{"visibility":"internal_provenance"}'::jsonb)
on conflict (canonical_url) do update
set display_name = excluded.display_name,
    enabled = true,
    approved = true,
    approval_note = excluded.approval_note,
    updated_at = now();

update public.rafa_knowledge_documents d
set review_status = 'superseded', approved_at = null, approved_by = null
from public.rafa_knowledge_sources s
where d.source_id = s.id
  and s.canonical_url = 'manual://owner-confirmed/refalco-group-structure'
  and d.canonical_content = 'LAMAR is part of REFALCO GROUP.'
  and d.review_status = 'approved';

with body as (
  select E'LAMAR''s former Cyprus company-formation services are now provided under REFALCO services.\nخدمات لامار السابقة لتأسيس الشركات في قبرص أصبحت تُقدَّم الآن ضمن خدمات ريفالكو.'::text as content
), inserted as (
insert into public.rafa_knowledge_documents
  (source_id, revision, title, canonical_content, content_sha256, language_code, review_status, approved_at, approved_by, metadata)
select s.id, coalesce(max(d.revision), 0) + 1, 'Former LAMAR services now under REFALCO',
       body.content, encode(extensions.digest(convert_to(body.content, 'UTF8'), 'sha256'), 'hex'),
       'mul', 'approved', now(), 'group-owner', '{"visibility":"internal_provenance"}'::jsonb
from public.rafa_knowledge_sources s
cross join body
left join public.rafa_knowledge_documents d on d.source_id = s.id
where s.canonical_url = 'manual://owner-confirmed/refalco-group-structure'
group by s.id, body.content
on conflict (source_id, content_sha256) do update
set review_status = 'approved', approved_at = coalesce(public.rafa_knowledge_documents.approved_at, now()), approved_by = 'group-owner'
returning id, source_id, canonical_content, content_sha256
)
select id, source_id, content_sha256 from inserted;

insert into public.rafa_knowledge_chunks (document_id, chunk_index, heading, content, metadata)
select d.id, c.chunk_index, c.heading, c.content, c.metadata
from public.rafa_knowledge_documents d
join public.rafa_knowledge_sources s on s.id = d.source_id
cross join (values
  (0, 'Former services now under REFALCO', 'LAMAR''s former Cyprus company-formation services are now provided under REFALCO services.', '{"language":"en"}'::jsonb),
  (1, 'الخدمات السابقة أصبحت ضمن خدمات ريفالكو', 'خدمات لامار السابقة لتأسيس الشركات في قبرص أصبحت تُقدَّم الآن ضمن خدمات ريفالكو.', '{"language":"ar"}'::jsonb)
) as c(chunk_index, heading, content, metadata)
where s.canonical_url = 'manual://owner-confirmed/refalco-group-structure'
  and d.title = 'Former LAMAR services now under REFALCO'
on conflict (document_id, chunk_index) do nothing;

with body as (
  select E'REFALCO''s services page describes remote assistance with setting up a company in Cyprus. Listed support includes preparing and submitting incorporation documents, reserving a company name, and following up on the application. The page lists a €999 package that includes four months of company secretary and registered address services.\nصفحة خدمات ريفالكو بتشرح خدمة تأسيس شركة بقبرص عن بُعد. وبتشمل المساعدة بتجهيز وتقديم أوراق التأسيس، حجز اسم للشركة، ومتابعة الطلب. الصفحة بتذكر باقة بسعر 999 يورو، تشمل أربعة أشهر من خدمات سكرتارية الشركة والعنوان المسجّل.'::text as content
), inserted as (
  insert into public.rafa_knowledge_documents
    (source_id, revision, title, canonical_content, content_sha256, language_code, review_status, approved_at, approved_by, metadata)
  select s.id, coalesce(max(d.revision), 0) + 1, 'Company setup in Cyprus', body.content,
         encode(extensions.digest(convert_to(body.content, 'UTF8'), 'sha256'), 'hex'),
         'mul', 'approved', now(), 'group-owner', '{"approved_scope":"company_formation_summary"}'::jsonb
  from public.rafa_knowledge_sources s
  cross join body
  left join public.rafa_knowledge_documents d on d.source_id = s.id
  where s.canonical_url = 'https://refalco.com/services/'
  group by s.id, body.content
  on conflict (source_id, content_sha256) do update
  set review_status = 'approved', approved_at = coalesce(public.rafa_knowledge_documents.approved_at, now()), approved_by = 'group-owner'
  returning id
)
insert into public.rafa_knowledge_chunks (document_id, chunk_index, heading, content, metadata)
select inserted.id, c.chunk_index, c.heading, c.content, c.metadata
from inserted
cross join (values
  (0, 'Company setup in Cyprus', 'REFALCO''s services page describes remote assistance with setting up a company in Cyprus. It lists help preparing and submitting incorporation documents, reserving a company name, and following the application. The page lists a €999 package including four months of company secretary and registered address services. If you want to register or set up an investment company in Cyprus, this is company-formation information, not investment advice or a promise of registration approval. What services does REFALCO offer? Company formation and company setup in Cyprus are described on its services page.', '{"language":"en"}'::jsonb),
  (1, 'تأسيس شركة في قبرص', 'صفحة خدمات ريفالكو بتشرح خدمة تأسيس شركة بقبرص عن بُعد. وبتذكر تجهيز وتقديم أوراق التأسيس، حجز اسم للشركة، ومتابعة الطلب. الصفحة بتذكر باقة بسعر 999 يورو، تشمل أربعة أشهر خدمات سكرتارية وعنوان مسجّل. إذا بدك تسجّل شركة استثمار بقبرص، فالمعلومات هون عن تأسيس الشركة، مو نصيحة استثمارية ولا وعد بالموافقة على التسجيل. شو خدمات ريفالكو؟ ما هي الخدمات التي تقدمها ريفالكو؟ صفحة الخدمات بتذكر تأسيس الشركات بقبرص. بدي اسجل شركة استثمار ب قبرص: طلب عن تأسيس الشركة ومعلومات عن نشاطها.', '{"language":"ar"}'::jsonb)
) as c(chunk_index, heading, content, metadata)
on conflict (document_id, chunk_index) do nothing;

commit;


