---
name: refal-milestone-execute
description: Execute a REFAL milestone from the authoritative brain master plan with phase evidence, independent audits, and guarded Supabase operations.
---

# REFAL milestone execution

Use this workflow when asked to execute a milestone in this repository. The authoritative roadmap is `.planning/REFAL-BRAIN-MASTER-PLAN.md`; read the repository `AGENTS.md` and relevant source analysis before work. Apply the generic `milestone-execute` workflow where available, then honor these REFAL-specific constraints.

- Preserve all existing user changes. Record the starting revision and dirty files before editing; never overwrite unrelated work.
- Translate every phase, wave, requirement, carry-forward, and acceptance gate into a traceability ledger. Keep the Master Plan authoritative and update it after each phase with statuses, exact commands/results, audit findings, validated root causes, focused fixes, and remaining external gates.
- Use parallel agents only for disjoint files or isolated worktrees. The coordinator owns the Master Plan and shared integration. Independent audit agents must inspect implementation after tests; reproduce each finding before fixing.
- Before any Supabase inspection or database operation, read `SUPABASE-ACCESS-GUIDE.md`, `.skyops/knowledge/INDEX.md`, and applicable Supabase skills. A local migration file is not a deployed migration. Preserve the plan's separate approval gate for live migrations, deployment, commit, and push.
- Never claim live behavior from mocks or synthetic tests. Never claim business facts without approved knowledge. Preserve privacy, RLS, service-role boundaries, booking confirmation, and failure-closed behavior.
- After each phase, regenerate an existing progress view if applicable. Mark a phase complete only when its implementation, tests, independent audit, validated fixes, and required gates have current evidence.
- At milestone end, run the full required regression and an independent cross-phase audit. Keep the goal active if any required evidence or gate is missing; document the exact blocker and continue all authorized local work.
