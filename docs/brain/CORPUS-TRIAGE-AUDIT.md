# Knowledge corpus audit and retrieval follow-up

**Date:** 2026-10-11
**Scope:** all 29 topics in English, Arabic and Greek (87 corpus files), checked against `AGENTS.md`, the owner-supplied master manual, `docs/brain/SOURCE-ANALYSIS.md`, `src/brainFactMap.js`, and `src/factCatalogue.js`.

## What was verified and changed

- All 87 expected files exist and pass `node scripts/validateCorpus.js`. The map's required MB-F, MB-C and MB-J fact IDs are present in all three language versions. The six dynamic variables remain governed by the corpus validator; no fact-register row, approval status, source provenance or trust metadata was changed.
- The separately recorded claim review in [`CORPUS-CLAIM-REPAIR-NOTE.md`](CORPUS-CLAIM-REPAIR-NOTE.md) removed claims unsupported by the source material from the permanent-residency, relocation and banking documents in all three languages. Those nine documents retain their required fact IDs. This audit did not repeat that repair or broaden it to unrelated customer-facing claims.
- The available live approved-knowledge diagnostic had 91 misses among 861 RAG-evaluated questions (770/861, 89.4%). These misses were top-five ranking misses; the language-matched document ranked first for all 879 questions. I added 75 question-form aliases across 43 corpus files, using the missed questions as evidence of lexical gaps. Numeric customer budgets and offer prices were removed from aliases; the only retained numeric query refers to the already-approved residency threshold MB-F30. Aliases are question anchors, not new factual claims.
- Rechecked the local lexical proxy after the alias changes: 878/879 golden questions clear the 50% token-overlap threshold, all 87 topic-language cells pass their minimum, and all 17 negative queries remain below the over-retrieval ceiling. The remaining proxy miss is `What are you?`, which has no content tokens under the configured stop-word list; its alias is present but cannot contribute token coverage. This proxy is not the live retriever and does not establish answer correctness.
- The offline health run reports five database checks pending because it was intentionally run without database access. The modified aliases have not been ingested into Supabase, so the 89.4% live retrieval result is a pre-change baseline; a post-ingestion live diagnostic is still needed.

## Gaps that need authoritative review

## Additional claim corrections (2026-10-11)

The EN/AR/EL `ownership-changes` topic now limits its direct procedural claim to the Cyprus Registrar's HE4 notice for director/secretary changes. Share transfers, investor entry/exit, consent, tax effects and filing routes are explicitly left for transaction-specific professional review. The EN/AR/EL `dormant-and-liquidation` topic no longer states categorical audit/tax/filing/penalty rules or that liquidation is the only closure path; it distinguishes inactivity from formal deregistration and points customers to current Registrar guidance and a Cyprus accountant/company specialist. These six copy edits are source-narrowing only: the documents still declare the existing MB-F14/17/18 identifiers, and the register remains unchanged. They passed the corpus validator. They do not establish approval or current legal advice; an authoritative review is still required before the agent can state these law-related facts.

- The fact map and the 87-file validation prove structural coverage, not sentence-by-sentence factual accuracy or native-language quality. This pass did not claim a complete semantic audit of the remaining 78 documents.
- High-risk tax, immigration, VAT and jurisdiction assertions in the source corpus still need primary-source verification and effective dates before they can be treated as current law. In particular, manual-derived claims should not be mistaken for a government-source citation merely because the row is in the fact catalogue. The manual is an implementation source, not automatically approved customer-facing evidence under `AGENTS.md`.
- Two topics use different numbers of sections across languages (`company-structures`: Arabic has four while English/Greek have five; `vat-and-eori`: English has eight while Arabic/Greek have seven). Required IDs are present and the difference alone does not establish omitted facts, but full native review should confirm that the detail and customer-facing boundaries remain equivalent.
- No model answer was generated or judged in this corpus-only pass. Perfect, interactive EN/AR/EL answers require representative answer samples, human factual/language review, and refusal-case review; retrieval and file validators cannot prove that outcome.

## Checks

- `node scripts/validateCorpus.js` — 87/87 clean.
- `node scripts/brainHealth.js --json` — 87/87 clean; 87/87 lexical cells passing; 878/879 golden questions reach the 50% lexical proxy; 17/17 negative queries below the ceiling; 5 database checks pending.
- `node --test src/corpusFile.test.js src/corpusIngest.test.js src/brainHealth.test.js scripts/runGoldenKnowledgeEvaluation.test.js` — this passed 200/200 on the first run. A later rerun, after concurrent edits elsewhere in the shared worktree, passed 199/200; `scripts/runGoldenKnowledgeEvaluation.test.js:78` failed because the MB-F9 dynamic offer fixture returned `found_stale_or_incomplete` instead of `found_current`. The failure is outside the corpus files and needs integration review.
- `git diff --check -- knowledge docs/brain/CORPUS-CLAIM-REPAIR-NOTE.md` — no whitespace errors. Git reported line-ending conversion notices for existing corpus files.

## F22/F26/F27 source and language follow-up (2026-10-11)

An independent official-source review found unsupported universal claims in the salary/dividend article, unsupported cost and delay narratives in the VAT/EORI article, and a fixed registration order. The candidate wording was narrowed in English, Arabic and Greek. The salary/dividend article now directs the actual company and personal tax treatment to qualified case review. The VAT/EORI page now uses a case checklist and matching VAT boundary section in all three languages; it avoids promising a common registration sequence or border delay/cost. A URL typo in the VAT registration FAQ citation was corrected. The related holding-versus-trading boundary now avoids blanket audit and treaty-only dividend claims.

Regression checks now assert trilingual VAT boundary/order parity and reject the reproduced universal claim patterns in the corpus. `src/corpusFile.test.js` and `src/factRegister.test.js` pass **68/68** focused checks; the complete corpus validator reports **87/87 clean**. An independent source auditor verified the core EORI definition against Cyprus Customs, checked the Tax Department VAT source, and confirmed the remaining language text needs native-speaker/legal review. All facts remain pending and non-statable; no database write or approval occurred.


A further copy pass narrowed the VAT/EORI topic titles, shipment checklist and intake promise in EN/AR/EL. The page now frames the material as requirements to check, says shipment responsibilities may help to agree in writing, and describes intake details as helping a specialist identify checks rather than promising a registration list. No facts were approved. Focused checks pass 69/69 and corpus validation passes 87/87. `npm run test:all` exits successfully, including dashboard 152/152. `git diff --check` reports no whitespace errors (only existing LF/CRLF notices).

## Corporate-tax boundary and source follow-up (2026-10-11)

The corporate-tax EN/AR/EL topic was narrowed after review found that it reduced taxable profit to accounting revenue less allowable costs, asserted blanket filing obligations for inactive companies, and implied four intake answers were enough to estimate liability. The copy now limits the common statement to the 15% headline rate from 2026, points the actual calculation to current rules and records, and makes the discovery questions explicitly preparatory. The per-language boundary explains that salary/distribution and treaty questions require case-specific review. MB-F19 now carries the Cyprus Tax Department T.D.4 rate-table URL and government fiscal report provenance; its fact remains pending. Regression coverage rejects the reproduced universal calculation and intake promises. Native-speaker and qualified tax review remain open.
