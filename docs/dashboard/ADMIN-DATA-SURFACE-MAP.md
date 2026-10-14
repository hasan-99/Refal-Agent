# REFAL dashboard data surface map

Inspected 2026-10-13 against Supabase project `anhharmjtmqndhzenicb` using table metadata only. The project exposes 38 application tables in `public`; authentication, storage, and Vault also contain platform-managed tables. This map is an admin navigation and write-boundary reference, not a request for a raw table editor.

## Company information administrators can maintain

| Data | Source | Dashboard surface | Supported changes |
| --- | --- | --- | --- |
| Validated company identity and operating footprint | `rafa_settings` key `company_identity`; validated `config/company-profile.json` is the startup/runtime fallback | Company brain → Company identity | Typed edit with mandatory reason; admin-only GET/PUT, validation, and audit event. Both Node WhatsApp and Edge prompt runtimes read the setting. Credibility figures are intentionally excluded and remain evidence-gated. |

| Data | Supabase source | Dashboard surface | Supported changes |
| --- | --- | --- | --- |
| Source catalogue | `rafa_knowledge_sources` | Company brain → Knowledge library | Add source, edit source metadata, fetch/import, enable or archive through reviewed controls |
| Versioned company content | `rafa_knowledge_documents` | Company brain → Knowledge library | Add a revision, edit pending revision, approve/return/reject with reason; approved revisions are indexed before use |
| Retrieval chunks and embeddings | `rafa_knowledge_chunks` | Knowledge detail and search preview | Generated from approved revisions; inspect/search through the product, never hand-edit embeddings |
| Fixed catalogue of evidence-gated claims | `refal_fact_register` | Company brain → Verified facts | Edit evidence/provenance and review state for canonical IDs; no arbitrary fact-ID creation |
| Fact review history | `refal_fact_register_audit` | Verified facts → audit | Read history; immutable audit events |
| Offers and prices | `refal_offers_and_pricing` | Company brain → Services and commercial data | Typed create/edit/delete with reason, review status, effective dates, and provenance |
| Renewal fees | `refal_annual_renewal_fees` | Same, Renewal fees | Typed create/edit/delete with reason and effective dates |
| Property inventory | `refal_property_inventory` | Same, Properties | Typed create/edit/delete with reason, status, and effective dates |
| Reservation terms | `refal_reservation_rules` | Same, Reservation rules | Typed create/edit/delete with reason and effective dates |
| Government fees | `refal_government_fees` | Same, Government fees | Typed create/edit/delete with reason and effective dates |
| Booking policy | `rafa_settings` key `booking_policy` | Bookings → Booking policy | Typed, bounded settings; save through the authenticated application route |
| Reply formatting and continuation | `rafa_settings` key `response_style` | Company brain → Response style | Typed paragraph, list, bold-label, continuation, and optional evidence-bounded related-service suggestion preferences; preview and save through the authenticated application route |
| Business guidance and conversation hooks | `rafa_settings` key `business_guidance` | Company brain → Business rules & hooks | Add, edit, enable, disable, and remove bounded guidance rules and multilingual optional hooks. Require a reason and record the changed rule/hook IDs in the admin event log. Settings feed both WhatsApp and dashboard Agent prompts; these entries cannot supply company evidence or override safety/booking policy. |

These categories are the company-facing sources of truth. Similar facts should not be copied into another editable catalogue. A new approved company statement belongs in the knowledge revision workflow; a canonical numeric/company claim belongs in the fixed fact catalogue; prices, availability, and terms belong in their typed commercial collections.

## Operational records with guarded dashboard workflows

| Data | Supabase source | Dashboard surface | Write boundary |
| --- | --- | --- | --- |
| Contacts and conversation history | `rafa_contacts`, `rafa_conversation_turns` | Leads and Conversations | View/update only through contact correction and chat lifecycle workflows; deleting a chat does not silently imply deletion of separately stored memory |
| Lead qualification and captured opportunity | `rafa_lead_qualifications`, `rafa_contact_intents`, `rafa_opportunity_intakes`, `refal_lead_profile`, `refal_lead_score` | Leads, conversation details, Performance | Review and correct through typed lead/contact workflows; scores are not edited as raw fields |
| Consent and follow-up state | `rafa_contact_consents`, `rafa_follow_up_states` | Conversation details and Follow-ups | Preserve consent provenance and state transitions; do not provide arbitrary status editing |
| Appointments and reminders | `rafa_appointments`, `rafa_reminder_jobs` | Bookings | Review/cancel through booking workflow; system-owned reminder transitions stay guarded |
| Human handovers and delivery | `rafa_handovers`, `refal_handover_delivery` | Follow-ups | Acknowledge, close, or retry through handover state-machine controls |
| Notifications | `rafa_notification_jobs` | Follow-ups | Draft, send, and retry only by supported notification actions |
| Complaints and priority alerts | `rafa_complaints`, `rafa_priority_alerts` | Conversations, Follow-ups, Performance | Inspect and resolve through complaint/escalation workflows; retain their audit trail |
| Existing-client verification state | `rafa_existing_client_verifications` | Agent runtime and conversation history metadata | System-owned verification state; dashboard has no direct editor. The table currently has zero rows. |
| Block list | `rafa_contact_blocks` | Blocked numbers | Admin-managed add/edit/remove with normalized phone numbers and audit events |
| Dashboard access | `rafa_dashboard_users` and Supabase Auth | Settings → Manage team | Invite, role change, activate/deactivate through admin access controls |
| Agent sessions, messages, and separate memories | `rafa_agent_sessions`, `rafa_agent_messages`, `rafa_agent_memories` | Agent workspace | Session lifecycle is owner-scoped; memories have separate add/delete actions and are not customer company knowledge |
| Admin audit | `rafa_audit_events` | Settings → Admin audit | Read-only history |

## Internal state that must not become editable company content

`rafa_events` supports telemetry and reporting. `rafa_inbound_message_receipts` prevents duplicate message processing. `rafa_knowledge_review_audit` records immutable knowledge decisions. `refal_rate_limits` enforces request limits. These records are read only or intentionally absent from the dashboard editor. Directly editing them can corrupt delivery, safety, or review behavior.

`rafa_events` also supplies the dashboard's limited admin-action history. `rafa_audit_events` is shown separately in Settings → Admin audit; the view removes contact IDs and applies the shared audit redactor to event details.

Supabase Auth tables (`auth.*`), storage metadata/objects (`storage.*`), and `vault.secrets` are platform/security surfaces, not company knowledge editors. Never expose credentials or a generic SQL/table editor to dashboard users.

Configured identity defaults come from `config/company-profile.json` and are validated at startup by `src/companyProfile.js`. Administrators can edit the typed `rafa_settings.company_identity` override in Company brain → Company identity; both Node WhatsApp and Edge prompt runtimes consume it. If the setting is absent or invalid, both use the validated profile default.

## Rule and hook boundary

The mandatory behavior rules in `config/refal-agent-rules.md`, shared prompt modules, deterministic safety gates, and appointment state machine remain code-managed. Administrators can maintain bounded business guidance and localized hook wording through the typed `business_guidance` setting; the prompt treats it as lower-priority preference data, never evidence, a fixed answer, or authorization. The legacy `salesHooks.js` selector remains dormant in the live answer path, and its phrases remain available to the anti-pattern detector. The active evidence-bounded global related-service preference remains in Response style.

The typed `allowRelevantServiceSuggestions` preference is exposed in Company brain → Response style. The generator emits enabled and disabled prompt branches, and live `rafa-agent-api` version 95 is active with JWT verification; remote read-back confirmed the dynamic identity route, setting loader, generated prompt support, and validator module. Dashboard Playwright coverage used mocked admin authentication and identity data because the current browser session has no valid dashboard login. No live identity setting was changed during that verification.

## Remaining dashboard gaps

- The 81 manual-only fact records are now pending with audit history. Replace their owner-manual provenance with current approved evidence, then review each fact before it returns to customer use. The one independently sourced authority fact remains approved. The Fact Register calls out manual-only evidence even while pending and provides a direct filter to those rows.
- Complete authenticated end-to-end verification when an administrator dashboard session is active; the current browser's local dashboard API returns 401 without one. Edge identity support is deployed as version 95 with `verify_jwt=true`.
- Follow-ups now distinguishes an unavailable queue from a successful empty queue, keeps the last loaded rows during refresh errors, and shows an unavailable count while the first request is pending or failed. A direct admin deep link is preserved until session authentication resolves. Mocked Playwright at 375px verified initial failure, retry recovery, retained rows after a failed refresh, and no horizontal overflow.
- Deploy and read back the `business_guidance` route before enabling its new editor against the live setting; verify its audited save and Node/Edge prompt consumption after release.
- Keep policy and hook controls categorized with the behavior they affect; avoid duplicated editable copies of the same company fact or rule.
