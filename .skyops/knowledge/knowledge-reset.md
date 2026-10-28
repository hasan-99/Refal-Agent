# Company knowledge reset for Sam — 2026-10-21

The owner requested an empty company knowledge base so Sam can populate it through the dashboard. The owner explicitly required keeping Company identity (`?section=company-brain&category=identity`).

On Supabase project `anhharmjtmqndhzenicb`, removed all 91 knowledge sources, 94 document revisions (English, Arabic, Greek), 612 chunks including embeddings, 82 registered facts, one pricing entry, and their dependent knowledge/fact review records. All eleven knowledge/commercial tables verified empty. Business rules/hooks were already empty.

Preserved all `rafa_settings` rows byte-for-byte at the database JSON level, including Company identity, response style, and booking policy. Protected row counts for accounts, contacts, conversations, agent sessions/messages/memories, appointments, and lead profiles were unchanged. Sam remains an active administrator.

A full local recovery export, checksums, bounded transactional reset SQL, and before/after evidence are in the ignored `artifacts/knowledge-reset-20261021/` directory. Old source documents, corpus files, and historical migrations remain reference material; they are not live customer-facing knowledge. Do not re-ingest or reseed the old corpus/facts without a new owner request. Sam owns adding and approving replacement knowledge through the UI.

Verification: nine read-only searches through the deployed worker API (company information, tax/accounting, banking in all three languages) returned zero matches. The dashboard displayed `0 revisions` and its empty knowledge-library state. No customer messages were sent by verification.
