ALTER TABLE public.rafa_contact_intents
  DROP CONSTRAINT IF EXISTS rafa_contact_intents_intent_check;

ALTER TABLE public.rafa_contact_intents
  ADD CONSTRAINT rafa_contact_intents_intent_check CHECK (intent IN (
    'company_formation','accounting','vat','cyprus_business_expansion','business_relocation','residency_enquiry',
    'real_estate_purchase','real_estate_investment','land_owner','property_development','construction_tender',
    'project_management','investment_opportunity','investment_partnership','strategic_partnership','infrastructure',
    'technology','operations','strategic_assets','business_proposal','supplier','career','media','general_information',
    'company_info','services','contact','legal','tax','immigration','banking','permit','approval','privacy',
    'unrelated','greeting','small_talk','real_estate','development','construction','land','investment','partnership',
    'corporate_services','customer_service','appointment','complaint','existing_client','prompt_injection','unknown'
  ));
