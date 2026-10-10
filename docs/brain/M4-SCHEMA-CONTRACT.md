# M4 schema and gateway contract

Migration: `20261010080201_refal_dynamic_commercial_data.sql`. Production application is **PENDING DB** until the owner authorizes the named migration. Local engine results do not establish deployment.

## Commercial rows

Kinds map to tables: `offers` → `refal_offers_and_pricing`, `renewals` → `refal_annual_renewal_fees`, `properties` → `refal_property_inventory`, `reservations` → `refal_reservation_rules`, `governmentFees` → `refal_government_fees`.

Every commercial row has UUID `id`, `source_note`, `reviewed_by`, `verified_at`, `effective_from`, `valid_until`, `review_status` (`draft`, `approved`, `blocked`), `active`, `location`, object `eligibility`, `vat_note`, ISO uppercase `currency`, `created_at`, and `updated_at`. Dates are timestamps with timezone. Required expiry strictly follows effective date; approved rows require named reviewer and verification date. All monetary values are nonnegative. Offer validity cannot exceed 30 days from verification. Do not assume other tables contain data.

| Kind | Additional fields |
| --- | --- |
| offers | unique `code`, `title_en/ar/el`, `amount`, array `inclusions`, `valid_from` (must equal `effective_from`) |
| renewals | `item` (secretary/address/accounting/audit/tax), `amount`, `period`, `notes_en/ar/el` |
| properties | unique `reference`, `city`, `type`, `status` (offplan/completed), `price`, `vat_rate_note`, `bedrooms`, nullable `first_sale`, nullable `pr_eligible`, `available`, `developer`, nullable `delivery_date` |
| reservations | unique text `project_or_property_id`, exactly one of `deposit_amount` or `deposit_percent`, nullable `refundable`, `conditions_en/ar/el` |
| governmentFees | unique `fee_type`, `amount`, `authority` |

Only serve rows with `active=true`, `review_status=approved`, nonfuture `verified_at`, `effective_from <= now < valid_until`; properties additionally require `available=true`. Reads must distinguish absent/expired/unavailable/error. All rows remain private to `service_role`; Node uses the authenticated Edge gateway rather than an anon Data API request that may silently return no rows.

## Lead foundation

`refal_lead_profile`: `contact_id` primary key references `rafa_contacts`, object `profile`, object `field_provenance`, nullable `source_turn_id`, `created_at`, `updated_at`. This is the minimal P4.1 foundation, extendable in P8.1. The trusted gateway derives customer identity, restricts supported fields, redacts sensitive data, and filters writes by contact. It must not accept model-provided ownership as authorization.

## Audited operator RPC

`refal_mutate_dynamic_data(p_kind text, p_operation text, p_id uuid, p_data jsonb, p_actor text, p_reason text)` returns the resulting row (or deleted row). Operations: `create`, `update`, `delete`. Create requires null `p_id`; update/delete require the existing UUID. Delete requires an empty object. The RPC validates table/column allowlists, rejects identity/timestamp changes, and commits its `rafa_audit_events` entry atomically. It uses security invoker with an empty search path, grants execute only to service_role, and has no browser policy. The Edge gateway must check current dashboard RBAC, derive `p_actor` from its trusted session, and reject unauthenticated calls. Audit source is `refal-dynamic-admin`, event `dynamic_data_create/update/delete`, actor type `operator`, and details contain actor, reason, table, before and after snapshots. Oversized snapshots fail the whole transaction, never write without an audit.

## Durable action receipt RPCs

Existing `rafa_audit_events` stores action receipts; no seventh table is introduced.

`refal_claim_dynamic_action(p_contact_id uuid, p_tool text, p_idempotency_key text, p_request_hash text)` returns `{claimed,receipt_id,state,result}`. Tool is one of the five named M4 actions. A unique partial index binds customer + tool + key; an advisory transaction lock serializes racing claims. New receipts return `claimed:true,state:pending`; matching duplicates return the stored state/result without executing again. Reusing a key with a different request hash fails. A durable pending receipt is intentionally not reclaimed after timeouts: uncertain external effects must be reconciled before retry.

`refal_finish_dynamic_action(p_receipt_id uuid,p_contact_id uuid,p_request_hash text,p_state text,p_result jsonb)` records `confirmed` or `failed` with the trusted customer's receipt and hash. Repeated identical completion is safe; conflicting completion fails. Result must be a small object with IDs/status and safe messages, not raw customer data. Receipt source is `refal-dynamic-tools`, event is the tool name. Calling code must alert internally on pending/failure and must only claim customer success after confirmed adapter results and receipt persistence.

## Seed and rollback

The only seed is the owner-approved formation package from MB §2.1: EUR 999 plus VAT, with its listed inclusions. Verification starts on the owner's source approval date (2026-10-07 UTC), expires 30 days later, and cannot be silently renewed by replaying the migration. `ON CONFLICT DO NOTHING` preserves operator changes. No property, deposit, renewal, government fee, or eligibility data is invented.

The migration's final `-- ROLLBACK:` block lists exact reverse statements without CASCADE. It removes only M4 RPCs, its receipt index, audit entries with the two M4 sources, and six M4 tables. It does not remove the existing audit table or existing update trigger function. Back up rows and check later milestone dependencies before any authorized rollback.
