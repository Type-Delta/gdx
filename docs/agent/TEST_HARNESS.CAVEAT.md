- `createTestEnv()` takes time setting up git repos. Use `createTestEnv()` with
  `liteMode: true` for tests that need a temporary directory and the harness
  `it`, but not a Git repository. Use the raw `it` from `bun:test` for tests
  that do not need harness features.
- Most tests expect the same execution order of `it()` in a `describe()`, so parallelization is at the file/describe level, not the individual test level.
- `bun run test` coordinates one parallel test-runner invocation (= `bun test --parallel`) and runs test _files_ in parallel
  worker processes. Tests inside a file still run serially in source order, so
  ordering assumptions within a `describe()` are preserved.
- `bun run test:serial` coordinates up to four serial invocations (`bun test`)
  on macOS and Windows. Linux bypasses the semaphore for speed, while still
  assigning each invocation its own `GDX_TEST_RUN_DIR` artifact root.
- The `scripts/test-runner.ts` wrapper creates a compact epoch-millisecond run
  root directly below `test/env`, removes direct child artifacts older than 24
  hours, and reports the artifact directory when the command ends. It also
  announces the path after allocation so Windows signal termination cannot
  swallow the only copy. Its temporary
  filesystem semaphore is keyed by the canonical repository path; killed
  owners are reclaimed using token-fenced metadata, PID liveness, and stale
  heartbeats.
- On macOS and Windows, the wrapper prints the slow-process warning once before
  starting Bun. Keeping the warning in the parent avoids one copy per parallel
  worker and preserves terminal color detection.
- Coordination details live in `getTestRunDir()` in `src/utils/testHelper.ts`:
  coordinated wrappers pass `GDX_TEST_RUN_DIR`; direct imports atomically claim
  one fallback marker and share its runner-owned root with sibling workers.
  The helper does not clear arbitrary `test/env/` entries; the wrapper owns
  retention cleanup and each suite's returned `cleanup()` removes its own root.
  Per-test timeouts are scaled (×3) inside parallel workers to absorb CPU/disk
  contention.
- The semaphore publishes fully written, UUID-owned intent directories and
  never reuses their paths. Heartbeats and PID checks reclaim abandoned intents
  without deleting a replacement generation.
- Prefer the `it` returned by `createTestEnv()` over the raw `it` from
  `bun:test`: only the harness `it` gets stdio capture, log dumping, and the
  parallel timeout scaling. Tests defined with the raw `it` fall back to Bun's
  default timeout (raised to 40s by `bun run test` via `--timeout`).
- While a harness `it` is active, subprocesses that normally inherit stdout and
  stderr are piped into that test's `buffer`. This includes Git commands routed
  through `execGit()`; their output is dumped only when the test fails.
- Always `await` async helpers like `resetRepo()` — a dangling git process
  bleeding into the next test causes `index.lock` races under parallel load.
