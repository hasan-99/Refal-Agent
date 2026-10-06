# REFAL Agent refactor — session handoff (2026-10-06)

Quick-start pointer for the next session. Full detail lives in
`docs/refal-agent-refactor-progress.md` (authoritative, very long — read
targeted sections, don't re-read it whole) and `docs/refal-agent-benchmark.md`
/ `docs/refal-agent-scenario-matrix.md`.

## State

- Repo: `C:\SharedProjects\Refal-Agent`, branch `feature/agentic-orchestration`.
- **Nothing is committed beyond `a0161f9` (tickets 001-010).** Tickets
  011-016's work (now including the 016 network-transport follow-up below)
  is real, tested, and sitting in the uncommitted working tree. Verify this
  is still true with `git status` before assuming anything — do not trust
  this file as proof of current state.
- Tickets 001-015: **DONE**, full suite was 527/527, now **543/543**
  (verify with `npm test` before relying on this number).
- Ticket 016 (real-model benchmark): **PARTIAL — blocker changed kind, not
  yet resolved.** Infrastructure is complete and tested
  (`src/benchmarkScorer.js`, `benchmarkEvaluator.js`, `benchmarkScenarios.js`,
  `benchmarkReport.js`, `scripts/runAgentBenchmark.js`, `npm run
  benchmark:agent`).
  - The original blocker — **this machine's NTLM corporate proxy blocking
    Node's `fetch()`** — is now root-caused and fixed: new
    `src/openrouterTransport.js` shells out to `curl.exe` (NTLM via Windows
    SSPI, no stored credential) only when explicitly opted in
    (`OPENROUTER_CORPORATE_PROXY=1`); default behavior (no flag) is
    unchanged. Verified with a REAL call to `https://openrouter.ai` through
    the real proxy — see the 2026-10-06 follow-up in
    `refal-agent-refactor-progress.md` under ticket 016.
  - **New blocker found by that same real call**: the `OPENROUTER_API_KEY`
    in this repo's `.env` is rejected by OpenRouter (`401 User not found`)
    and is far shorter (22 chars) than a real OpenRouter key — reads as a
    placeholder, not a live credential. **`npm run benchmark:agent` was
    deliberately NOT re-run** with this key — every call would fail the same
    way and produce the same uninformative result shape, misrepresenting a
    credential problem as a repeat of the (now-fixed) network problem.
  - To actually close 016: set a valid `OPENROUTER_API_KEY` (from wherever
    this project's real key is kept) in `.env`, then run
    `OPENROUTER_CORPORATE_PROXY=1 npm run benchmark:agent -- --runs=3` from
    this machine (or run it unmodified from any environment with direct
    internet access, where the flag is simply not needed).

## Do NOT

- Do not start REFAL-AGENT-017 (live cutover). Explicitly blocked until an
  Opus architecture/benchmark review happens, which itself needs a real
  `OPENROUTER_API_KEY` + `npm run benchmark:agent` re-run first.
- Do not commit/push without the user asking for that specific action.
- Do not treat ticket 016's benchmark report numbers as a real quality
  verdict on the Agent until it has been run with a valid API key — the
  current artifact on disk (if any) still reflects the old network-blocked
  run, not Agent behavior.
- Do not invent, guess, or regenerate an `OPENROUTER_API_KEY` value — ask the
  user where the real one is kept.

## Open follow-up tickets (proposed during 014/015, not started)

- REFAL-AGENT-022 — safetyPolicy.js bare-credential-keyword false positive
- REFAL-AGENT-023 — followUp.js Arabic/Greek goodbye bug (the Arabic branch
  is actually unreachable due to a `\b`-on-non-Latin-script JS regex bug,
  not just "Greek missing") + Arabic-only re-engagement message
- REFAL-AGENT-024 — conversationRecap.js fixed-backstory bug
- REFAL-AGENT-025 — booking.js has no Greek natural-language date normalizer
- REFAL-AGENT-026 — Agent path has no response-language equivalence
  validator (legacy `ai.js:227` has one, Agent path has none)

## Natural next step

Either: (a) re-run `npm run benchmark:agent` from an environment with real
OpenRouter network access to get the actual Ticket 016 numbers, then proceed
to the Opus review; or (b) pick up one of the 022-026 follow-up tickets if
the user wants bug fixes before the benchmark re-run.
