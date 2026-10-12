# Isolated tests and CI

Use Node 24 and install dependencies with `npm ci` in both `backend` and `frontend`.
No `.env` file, application MongoDB URI, provider credentials or CI secrets are needed.

From `backend`:

```sh
npm run typecheck
npm run build
npm run test:unit
MONGOD_BINARY=/path/to/mongod npm run test:integration
MONGOD_BINARY=/path/to/mongod npm run test:e2e:ci
```

On PowerShell, set `$env:MONGOD_BINARY = 'C:\path\to\mongod.exe'` before the database commands.
Install MongoDB Community Server 8.x; the harness starts its own loopback process,
random port, temporary data directory and single-member replica set. It waits for
a writable primary before starting suites. Missing binaries fail instead of skipping tests.

Each suite gets a UUID database (`smartorder_test_<uuid>`; the demo fixture uses
`smartorder_ai_demo_test_<uuid>`). Separate workers and simultaneous test invocations
do not share databases. Mongoose and driver connection guards only permit the exact
allocated server/database. DB overrides and destructive driver operations are guarded.
Teardown closes connections, drops only that suite's database and stops/removes only
the process/directory created by the invocation. Collection resets preserve indexes.

Unset `MONGODB_URI`, `TEST_MONGODB_URI`, `AI_DEMO_TEST_MONGODB_URI` and
`AI_DEMO_MONGODB_URI` in the launching shell. An external URI (even a test URI) is
rejected before starting MongoDB. There is no external-server mode or `.env` fallback.
The harness supplies `MONGODB_URI` internally only so AppModule can use its existing
configuration. E2E uses fixed dummy secrets; demo staff bootstrap and scheduled
abandoned-session cleanup are disabled, while callable service methods remain available.

`npm test` / `npm run test:unit` run all backend unit suites with MongoDB connections
blocked. `npm run test:e2e` runs all legacy E2E suites through the same isolation guard.
The old `test/jest-e2e.json` entry point also has the guard for existing callers.
The old `seed:merge-test` helper now refuses to write to existing databases; use the
isolated session-merge E2E entry point for its fixtures instead.
CI runs the full backend unit suite. The compatibility command `test:unit:ci` uses
the same configuration as `test:unit`; it no longer selects a smaller subset.
Integration runs all six suites; E2E CI selects app/AI audit/demo persistence tests.
The stabilization checkpoint on 12 October 2026 passed 761 unit, 27 integration,
13 selected E2E and 32 frontend tests (833 total, zero skipped). Backend/frontend
build and typecheck also passed locally. The full legacy E2E suite and live AI
evaluations were not run in that checkpoint; these numbers do not claim their status
or a successful GitHub-hosted workflow run.

From `frontend`, run `npm run typecheck`, `npm run build` and `npm test` with
`VITE_API_URL=http://127.0.0.1:3000` for the build. No API server is needed for these tests.
CI uses these commands on Ubuntu 24.04 and installs the server binary from the
[official MongoDB 8.0 repository](https://www.mongodb.com/docs/v8.0/tutorial/install-mongodb-on-ubuntu/).
Every failed step fails the job; no test skip fallback, coverage gate or write-mode lint
is used. `npm run lint` is read-only; formatting is a separate developer command.
