# M4 baseline verification

Independent verification recorded 2026-10-10, before M4 implementation.

- Starting revision: `579f71c9d3ddf07f8480318e6a59179d570eaf36`.
- Starting working tree: clean (`git status --short` produced no output).
- Scope: local automated tests and frontend compilation. No Supabase writes, external actions, app code edits, commits, or pushes were performed by this verifier.
- Authority read: `AGENTS.md` and `.planning/REFAL-BRAIN-MASTER-PLAN.md`, including mandatory G1–G7 gates, anti regression checklist, M4 phases, and database boundaries.

## Commands and evidence

Commands ran concurrently. Each command redirected its own output to a file, captured `$LASTEXITCODE` immediately, and wrote timestamps and the exit code to a JSON result file. Logs and result files are under ignored `artifacts/m4/baseline/`.

| Command | Exit | Result | Log / result |
| --- | --- | --- | --- |
| `npm test` | 1 | 1787 tests, 1785 pass, 2 fail | `root-test.log`, `root-test-result.json` |
| `npm --prefix dashboard test` | 0 | 94 tests, 94 pass, 0 fail | `dashboard-test.log`, `dashboard-test-result.json` |
| `npm --prefix dashboard run build` | 0 | Vite built 1758 modules; build reported 3.81 s | `dashboard-build.log`, `dashboard-build-result.json` |

Root suite ran 11:01:25–11:01:31, dashboard tests 11:01:26–11:01:30, dashboard build 11:01:26–11:01:33, Asia/Nicosia (`+03:00`). These are local fixture tests; a build does not prove runtime CRUD or live service access.

## Confirmed pre-existing baseline defect

Both failures occurred on the clean starting revision and are not introduced by M4:

1. `src/mirrorParity.test.js:373`: **every committed mirror is byte-identical to what the generators emit**.
2. `src/promptParity.test.js:199`: **W1.7.4: the generated mirror has not drifted from src/brainPrompt.js**.

**Root cause confirmed without changing generated files:** `core.autocrlf=true` has checked out the ten generated `.mjs` mirrors with CRLF line endings. Both generators produce LF output and compare raw strings. Evaluating each generator with `fs.writeFileSync` replaced by an in-memory comparator showed all ten mirrors differ byte-for-byte but match exactly after CRLF→LF normalization. The affected mirrors are `responsePolicy`, `language`, `safetyPolicy`, `bankingPolicy`, `reservationPolicy`, `crossCustomerPolicy`, `outputGuards`, `claimPolicy`, `refalcoAnswer`, and `brainPrompt` under `supabase/functions/rafa-agent-api/`.

Reproduction: run the two existing test files, or run both generators with `--check`, in this Windows checkout before the repair below. This is a checkout/generator portability defect, with no demonstrated semantic prompt or policy drift.

### Validated repair

The coordinator subsequently assigned this verifier the repair. Added `.gitattributes` with explicit `text eol=lf` entries for the ten generated mirrors and ran both existing generators. No generator, application logic, or equality assertion changed. Regeneration changed only working-tree line endings; `git diff --numstat -- supabase/functions/rafa-agent-api` produced no output.

- `node --test src/mirrorParity.test.js src/promptParity.test.js` → **exit=0, 28 tests, 28 pass**, 11:03:03–11:03:04 Asia/Nicosia. Evidence: `parity-repair.log` and `parity-repair-result.json`.
- `npm test` → **exit=0, 1787 tests, 1787 pass**, 11:03:18–11:03:23 Asia/Nicosia. Evidence: `root-after-repair.log` and `root-after-repair-result.json`.
- Fresh index checkout of `brainPrompt.mjs` and `responsePolicy.mjs` into ignored `artifacts/m4/baseline/checkout/`, followed by a Node assertion of no CRLF, → **exit=0** with `core.autocrlf=true`. This confirms the attributes protect subsequent Windows checkouts, rather than only the regenerated current files.

The baseline portability failure is repaired. M4 feature gates remain independent of this baseline repair.

## Reusable skill independent review

Reviewed `C:/Users/hasan/.codex/skills/milestone-execute/SKILL.md` against the requested autonomous execution and this plan.

The skill covers parallel ownership, requirements tracing, independent audits, validation before fixes, regression coverage, phase updates, final audit, actual exit codes, blockers, and reserved publication/database boundaries. It correctly does not let a passing build or synthetic evidence stand in for live behavior. No contradiction with the user's requested workflow was found.

Two operational details are currently inherited only through the instruction to preserve the master plan, rather than restated as explicit reusable behavior:

- G6 requires building the configuration mechanism, shipping a working default where safe and applicable, and naming the single editable field for a missing value. Generic dependency reporting alone must not be used to park implementable mechanisms.
- G3/G4 require `COVERED` / `PARTIAL` / `MISSING` requirement classifications and severity, reproduction, and regression-test identifiers for defect rows in the master plan. The skill requests findings and evidence but does not enumerate those fields.

These are execution risks to account for in this milestone's traceability and results, not evidence that M4 is complete or that its implementation should be changed. No phase was signed off by this baseline report.
