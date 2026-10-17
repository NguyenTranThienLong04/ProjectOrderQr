# Legacy unresolved payment migration

Explicit CLI only; no startup migration or automatic `.env` loading. Confirm the
host/database against the deployed service, then run from `backend`:

```sh
npm run migrate:payment-intents -- --env-file .env --deployment production --expected-host HOST --expected-db DATABASE
```

Default dry-run exports **full** affected session PaymentIntents (including settled
history) and related Orders to a unique `backend/tmp/payment-intent-migration-backup-*.json`
file using Extended JSON. `tmp/` is gitignored. The file is flushed and read back
before any database write. Credentials/configuration are never exported.

Safe resolution requires either a persisted confirmed failure or an original,
authenticated failure IPN supplied as a JSON array with `--ipn-evidence FILE`.
The script verifies HMAC, terminal, txnRef, amount, response/transaction status and
checks the covered Orders and conflicting success evidence. It only updates the
failed checkout to `failed + ipnConfirmed: true`; this failure path never creates success, deletes
history, changes Orders or chooses a winner based on age. Expiry and a different
successful checkout do **not** prove this txnRef failed. QueryDr response codes
are not IPN response codes: do not pass QueryDr responses as IPN evidence.

If any group remains ambiguous, all database writes stop. Reconcile the reported
txnRefs through VNPAY and retain the authentic evidence. Do not manufacture an IPN
or set `ipnConfirmed` merely to get the index built.

For the current Sandbox incident, query the two unresolved transactions read-only:

```sh
npx ts-node scripts/query-payment-intents.ts --env-file .env --deployment production --expected-host HOST --expected-db DATABASE --session-id SESSION_ID --ip-address QUERYING_MACHINE_PUBLIC_IP
```

The CLI extracts the original payment `vnp_CreateDate`, checks the original merchant,
signs QueryDr requests and validates the response HMAC plus transaction identity and
amount. It saves the response evidence in ignored `backend/tmp/` and never writes
MongoDB. `02 / Website not approved` without a response signature is **unknown**,
not a failed payment. Resolve merchant/QueryDr access with VNPAY before retrying.
Even a signed QueryDr `vnp_ResponseCode=00` only means the query succeeded; payment
outcome comes from `vnp_TransactionStatus`. Do not feed a QueryDr report into the
existing `--ipn-evidence` option or translate an unknown result into failure.

For this incident, authenticated Sandbox portal details confirmed both old checkouts
as successful. `--portal-evidence FILE` accepts an operator-verified capture with
`source: "vnpay-sandbox-merchant-portal"`, `capturedAt`, and `payments` containing
merchant, txnRef, amount/currency, succeeded status, response code, transaction number,
confirmation time, and the original PaymentDetail URL. Retain raw search/detail
captures in that file. This is manual portal evidence, not a signed IPN: verify it
in the authenticated portal before supplying it. The backup retains the evidence
and its SHA-256 digest. Identity, original Sandbox URL/merchant/amount, terminal
result, dates and complete Order totals must agree; every conflicting intent must
be resolved. Only already-Paid Orders are supported by this narrow success path.
It sets the intent to `succeeded` with the actual transaction number, response code
and confirmation time, leaving `ipnConfirmed`, Orders and other history unchanged.
Multiple successful payments covering an Order remain visible for overpayment
review; this migration does not refund payments or reassign the Order's paid audit.

This fully-settled portal success path can apply online without claiming writers
are paused: full snapshot comparison and transactional conditional updates abort
on concurrent intent changes. Both duplicate counts are checked inside the
transaction. Index creation remains additive and fails if concurrent traffic
introduces another conflict. All other apply paths still require paused writers.

After a clean dry-run, pause all checkout/IPN writers (including local instances)
and rerun the same command with `--apply --writes-paused`. This flag is an operator
attestation, not a distributed lock. The migration checks the backed-up documents
again inside a transaction, resolves only conflicting groups, then creates **all**
schema indexes additively and verifies both unique partial indexes, preserved
history and unchanged Orders. Resume traffic only after verification succeeds.
If index creation fails, retain the backup and reconcile the reported index issue;
do not drop constraints. Repeating the command is safe.

Deploy/restart the backend only after migration and index verification succeed.
Check `/health` and startup logs; a local build is not evidence of a Render deploy.

## Operator reconciliation: terminal rejected before payment creation

`reconcile-provider-rejections.ts` is a separate, narrow CLI for expired Sandbox
checkouts with operator-verified gateway code 71 **and** a matching merchant-portal
search showing no transaction. An unsigned QueryDr error or expiry alone is not
evidence. Record the operator's original confirmation; do not invent portal data.

The terminal state is `provider_rejected`, with `resolutionSource: reconciliation`,
`providerCode: 71`, `resolutionReason: terminal_not_approved`, `resolvedAt`, a note
and the evidence SHA-256. `ipnConfirmed`, `responseCode`, `transactionNo`, Orders,
and all existing history fields are preserved. The public status API maps this
terminal state to `failed`; a contradictory later IPN requires manual review.

The existing unresolved predicate already excludes this new terminal status.
Its definition and both unique partial indexes are unchanged. No index replacement,
drop, or startup migration is required. A `failed` or `pending` document remains
reserved even if somebody adds reconciliation metadata without the terminal state.

Evidence follows the exported `ProviderRejectionEvidence` type: operator source,
confirmation time/note, merchant TmnCode and website, actual website/return URL,
Sandbox portal URL, search date, gateway code, and exact txnRef/session/amount/order
IDs/original `vnp_CreateDate` plus portal `not_found` for each checkout. This is
manual evidence, not a cryptographically authenticated provider receipt.

```sh
npm run reconcile:provider-rejections -- --env-file .env --deployment production --expected-host HOST --expected-db DATABASE --evidence tmp/operator-confirmation.json
# After inspecting the dry-run and saved backup:
npm run reconcile:provider-rejections -- --env-file .env --deployment production --expected-host HOST --expected-db DATABASE --evidence tmp/operator-confirmation.json --apply
```

The CLI verifies original URL signatures with the original merchant's secret,
scope, dates, amount, Orders and indexes. It flushes and reads back a unique full
backup, then compares snapshots and updates the exact intents in one transaction.
Concurrent intent changes abort. It does not call VNPAY or create a new checkout.
Repeated application of identical evidence is a no-op. Keep the private backup
and evidence in ignored `backend/tmp/`; never commit credentials or signed URLs.

For the 16/10/2026 incident, the operator confirmed terminal `18YSJO04` is registered
to `abc.com`, while SmartOrder uses `https://smartorder-web-1bhs.onrender.com`.
Ask VNPAY to correct/approve that website and enable PAY/QueryDr, or issue an
approved Sandbox merchant for it. Do not reuse credentials from another terminal.

After approval, the Render backend configuration is:

```dotenv
VNP_TMN_CODE=<approved_sandbox_terminal>
VNP_HASH_SECRET=<secret_for_that_same_terminal>
VNP_URL=https://sandbox.vnpayment.vn/paymentv2/vpcpay.html
VNP_RETURN_URL=https://smartorder-api-fi7k.onrender.com/vnpay/return
VNP_IPN_URL=https://smartorder-api-fi7k.onrender.com/vnpay/ipn
FRONTEND_URL=https://smartorder-web-1bhs.onrender.com
CORS_ORIGIN=https://smartorder-web-1bhs.onrender.com
VNPAY_DEBUG=false
```

`VNP_PAYMENT_URL` is not read by this project: use `VNP_URL`. `VNP_IPN_URL` is an
operator reference; register it in VNPAY's portal. Deploy the backend change for
the public failed-status mapping and explicit contradictory-IPN handling. Env
changes also require deployment. After approval, verify a new Sandbox checkout
reaches the payment screen; do not create one while the merchant is still rejected.
