# Phase 24 evaluation

`dataset.v1.ts` is the authored **ai-release-golden-v1** corpus. It contains 39
cases: 5 Dish Draft, 11 Order Note, 6 Semantic Search, 9 Analytics, and 8 Review
Intelligence (7 classification cases + 1 summary). Earlier versioned note/review
fixtures are reused explicitly. Change the dataset version when changing labels.

From `backend/`:

```powershell
npm run eval:ai
npm run test:ai-evaluation
npm run test:ai-release -- --silent
npm run eval:ai:live
```

- `eval:ai`: exercises actual feature services, prompts, orchestrator, local output
  validation, search predicates and analytics arithmetic against synthetic
  repository/provider doubles. Writes `docs/evaluation/phase24-golden.json` and
  exits nonzero on any mismatch. It measures **contract/grounding regression**, not
  live language accuracy. No network/database access.
- `test:ai-evaluation`: OpenAI and Groq each run all 39 golden cases through the
  actual resolver/adapter with mocked HTTP. Groq adds 48 failure cases and two
  duplicate-array rejection cases against the unchanged server validators.
  Gemini regression runs all 39 cases through the real SDK
  with simulated HTTP and 42 failure cases across five features (including both
  review stages). No provider network or database is required. Six negative controls deliberately reverse a note, omit an
  allergen filter, invent an ingredient, select the wrong analytics metric, drop
  review topics or invent summary sample size. The evaluator must reject all six.
- `test:ai-release`: real AppModule + HTTP + two Socket clients + MongoDB on a
  unique database name. Requires non-production `MONGODB_URI`; its database path is
  always overridden. Uses the actual provider adapter with fetch simulation.
  Payment uses a synthetic signing key and local HTTP IPN, never a live payment.
  Cleans fixture IDs/ownership only and asserts zero remaining documents. Writes
  `docs/evaluation/phase24-http.json`; **Jest exit status is the overall gate**, not
  the presence of this partial-results file. Default application seeding is disabled.
- `eval:ai:live`: sends only these synthetic cases through the actual configured
  provider and all five feature services; repository/audit writes remain in-memory.
  Requires `AI_ENABLED=true`, valid timeout/retry configuration, and either
  `AI_PROVIDER=openai` + `AI_API_KEY` + `AI_MODEL`, or
  `AI_PROVIDER=gemini` + `GEMINI_API_KEY` + `GEMINI_MODEL`, or
  `AI_PROVIDER=groq` + `GROQ_API_KEY` + optional `GROQ_MODEL`
  (default `openai/gpt-oss-20b`).
  It uses the same resolver as AiModule and does not edit `.env` or enable AI.
  Missing credential exits 1 before network/DB with all five features **NOT VERIFIED**.
  Writes `docs/evaluation/phase24-live.json` for OpenAI or `gemini-live.json` for
  Gemini, or `groq-live.json` for Groq, separately from fixture evidence.
  With a credential this is a paid provider evaluation (46 calls without retries).

For the smaller sequential provider smoke, run `npm run eval:ai:live -- --smoke`.
It runs Dish Draft, Order Note, Semantic Search, Analytics (both stages), then
Review Intelligence classification and summary: six representative cases, seven
provider calls without retries. Gemini writes `docs/evaluation/gemini-smoke.json`.
Groq writes `docs/evaluation/groq-smoke.json`; selected cases add `-selected` to
the filename. Use the same command with `AI_PROVIDER=groq`. See
[Groq verification](../../../docs/groq-provider-verification.md).
Gemini live smoke now waits 30 seconds between cases to avoid a burst of requests
against per-minute quotas; production deadlines/retries and feature latency are
unchanged. Override with `--interval-ms=0..60000` if needed. This is pacing, not an
extra retry loop or a guarantee against quota/overload failures.
Every live case requires successful provider audit evidence; a fallback alone
cannot produce a live PASS. This is real provider/service verification with
synthetic repositories, not a live HTTP/database or browser check. Configure only
`backend/.env`, restart the backend, and follow [Gemini verification](../../../docs/gemini-provider-verification.md).

By default, live output reports contain case IDs, status, normalized error codes and
allowlisted stage metadata only: prompt/model version, latency, attempts and
provider-reported usage. No input/output prose, API keys, prompts, connection URI,
allergy text or reasoning is printed/persisted. No token estimates or cost guesses.
`GOLDEN_MISMATCH` means one of the authored expectations failed; inspect the case
and rerun in a controlled development session instead of logging raw production data.
Failed provider audit codes take precedence over assertions about unavailable
feature results (for example a quota failure is not mislabeled as wrong taxonomy).
Evaluator v4 retains `failureCategory`: `provider_quota_or_network`,
`schema_or_server_validation`, `golden_semantic`, `configuration_or_request`, or
`other`. Phase 17 intentionally shares `AI_INVALID_OUTPUT` between JSON, DTO and
server semantic rejection; this evaluator does not invent a narrower distinction.
A `GOLDEN_MISMATCH` with successful stages is a semantic failure, not evidence of
quota/network failure. Guardrails and authored golden expectations are unchanged.

For development-only compatibility debugging of synthetic fixtures:

```powershell
$env:NODE_ENV='development'
npm run eval:ai:live -- --smoke --diagnostics
# Optional targeted run; writes gemini-smoke-selected.json with explicit case IDs.
npm run eval:ai:live -- --smoke --cases=dish-pho,analytics-revenue,review-1,review-summary-grounding --diagnostics
```

`--diagnostics` is rejected unless live mode and NODE_ENV=development|test. It adds
sanitized synthetic feature inputs (including backend facts), expected checks,
provider JSON outputs and HTTP errors to the evaluator report/console.
Each case prints `CASE`, `INPUT`, `EXPECTED`, `ACTUAL <PROVIDER> STRUCTURED OUTPUT`,
`SERVER VALIDATION`, `GOLDEN CHECK` and `FAIL REASON`; the report stores the same
comparison. Provider failures leave unexecuted validation/golden checks NOT
VERIFIED. Failed assertions include their sanitized message, without exception
stacks or vendor exception text. Search `keywords` remain visible, while secret
values inside them are still scrubbed. These diagnostics never alter scoring.
Environment secrets, key/JWT patterns, URLs, private fields and reasoning are
redacted; no transport envelope, headers, system prompt or production audit is logged.
The fetch observer is restored after each case. This helper is never imported by
production modules. Keep this flag confined to authored synthetic evaluation.
See [Groq semantic verification](../../../docs/groq-live-semantic-verification.md)
for the targeted three-case fix and subsequent quota-limited full smoke.

Dish naturalness/factual prose review remains a human gate: use
`DISH_REVIEW_RUBRIC` and the five dish names. Automated identity/claim screens are
deliberately conservative and cannot certify arbitrary text. A valid translation
may need rubric review even when an exact identity check fails. Do not turn
fixture replay success into a claim that a real LLM cannot hallucinate or obey
prompt injection. Analytics intent/periods are scored separately from numeric
facts, because the tools return several metrics even when one metric was requested.
For `dish-pho`, identity accepts either the Vietnamese name or English name with
all three concepts pho/beef/rare, without requiring one exact translation sentence.
The required fields and existing unsupported factual/allergen screen still apply;
automated checks are a conservative screen, not a complete prose truth validator.

Recommendation is deterministic: provider errors are inapplicable. Its real DB
cache baseline is in the HTTP report; ranking, thresholds, cache expiry/coalescing,
history failure recovery and the 640-basket scenario are covered by Phase 23's
existing unit/E2E suites. Built-UI tests are the existing scripts for Phases 18–23;
their HTTP/Socket business replies are mocked and clearly distinct from Mongo E2E.
