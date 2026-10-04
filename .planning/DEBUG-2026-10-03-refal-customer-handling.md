# Debug: REFAL company setup enquiry handling

Date: 2026-10-03

## Symptom

A customer asked in Syrian Arabic to register an investment company in Cyprus. REFAL skipped basic service information, told the customer a specialist was needed, asked an unclear qualifying question, then offered contact instead of answering the request.

## Root cause

- Colloquial Syrian company-registration phrasing was not consistently classified as company formation, so the broader investment intent dominated.
- The priority path treated that label as an immediate handover instead of internal context.
- The approved REFALCO services page was stored only as a pending revision; no current, approved service summary was available to retrieval.
- English, WhatsApp, dashboard, and Edge prompts did not consistently require answer-first, one-question-at-a-time collection and optional, consent-based follow-up.
- Existing lead scoring treated company mentions as decision authority and reused prior inferred scores; object-shaped handover summaries rendered as `[object Object]`.

## Changes

- Recognized the colloquial Arabic phrase as both company formation and investment while keeping the conversation in the information flow.
- Kept high priority internal for ordinary formation enquiries; genuine material, sensitive, complaint, and existing-client cases remain eligible for specialist handling. The customer-facing offer asks permission rather than demanding contact details.
- Aligned WhatsApp, dashboard, Edge Function, and canonical rules on plain Syrian/Levantine Arabic, answer-first behavior, one useful question per turn, progressive details, and consent before contact.
- Imported the current REFALCO services page. The raw revision remains pending review; only a narrow bilingual company-formation summary is approved, with unsupported legal, tax, timeline, and guarantee claims excluded.
- Removed stale LAMAR knowledge sources and retained only the corrected internal bilingual transition fact.
- Prevented generic company mentions and stale inferred scores from setting decision authority; made dashboard summaries readable.

## Verification

- `npm test`: 121 tests passed.
- `node --test dashboard/activity.test.js src/priorityRules.test.js src/leadQualification.test.js`: 13 tests passed.
- `node scripts/evaluateKnowledge.js`: 16 passed, 0 skipped, 0 failed, including the exact Syrian-Arabic request.
- Dashboard production build succeeded; `http://127.0.0.1:8787/` returned HTTP 200.
- WhatsApp worker restarted and logged ready against Supabase.
- Supabase `rafa-agent-api` deployed as version 29 with JWT verification enabled.

## Limit

The company setup package price is approved evidence but must only be volunteered when the customer asks about price. A registration outcome or investment advice is never promised.
