- `createTestEnv()` takes time setting up git repos, use `createTestEnv()` with `lite: true` for faster tests that don't need git repos, but require a temporary directory and harness `it` with stdio capture and log dumping. Else you can use the raw `it` from `bun:test` for even faster tests that don't need any of the harness features.
- Most tests expects the same execution order of `it()` in a `describe()`, so parallelization is at the file/describe level, not the individual test level.
- `bun run test:parallel` (= `bun test --parallel`) runs test _files_ in parallel
  worker processes. Tests inside a file still run serially in source order, so
  ordering assumptions within a `describe()` are preserved.
- `bun test` (serial) remains fully supported.
- Coordination details live in `clearTestEnvs()` in `src/utils/testHelper.ts`:
  stale `test/env/` entries from previous runs are cleared exactly once per run
  via an atomically-created `.gdx-test-run-<key>` marker file, so concurrent
  workers never delete each other's live environments. Per-test timeouts are
  scaled (×3) inside parallel workers to absorb CPU/disk contention.
- Prefer the `it` returned by `createTestEnv()` over the raw `it` from
  `bun:test`: only the harness `it` gets stdio capture, log dumping, and the
  parallel timeout scaling. Tests defined with the raw `it` fall back to Bun's
  default timeout (raised to 20s by `test:parallel` via `--timeout`).
- Always `await` async helpers like `resetRepo()` — a dangling git process
  bleeding into the next test causes `index.lock` races under parallel load.
