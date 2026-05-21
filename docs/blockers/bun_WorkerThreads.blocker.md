# Unreliable Worker Threads in Bun Compiled Binaries: Findings and Mitigations

This note captures the worker-related findings from investigating broken `gdx show` syntax highlighting across Bun source, Bun compiled binaries, Node package output, and npm-installed launcher flows.

## Context

`gdx show` uses the diff viewer to syntax-highlight changed lines. For better context, the viewer can highlight the full old/new file and then map highlighted lines back onto the diff. That full-file highlighting path was originally run through `Threaded`, which uses `node:worker_threads`.

The goal was to keep full-file syntax highlighting threaded while supporting these runtimes:

- `bun run start -- show ...`
- `bun run start:node show ...`
- `node ./dist/index.js show ...`
- npm-installed `gdx show ...`
- Bun compiled binary from `bun run build`

## Finding 1: Eval Workers Have Unreliable Package Resolution

The original `Threaded` implementation created workers from an eval string:

```ts
new Worker(WORKER_SOURCE, { eval: true, workerData: ... });
```

Requirements such as `@shikijs/cli` were then imported inside that eval worker:

```js
globalThis[requirement.name] = await import(requirement.source);
```

This fails in packaged or compiled contexts because the eval worker does not necessarily have a useful module URL/base for resolving bare package imports.

Observed failure shape:

```text
Cannot find module '@shikijs/cli' from 'blob:...'
```

Mitigation implemented:

- Resolve bare imports before passing them to the worker.
- Use a real file worker source for package/source runtimes where possible.

## Finding 2: Bun Compiled Binary Hangs With Worker File Path

Attempted approaches for Bun compiled binaries:

- Static source worker URL using `new URL('../workers/generic.worker.ts', import.meta.url)`.
- Sidecar worker at `bin/workers/generic.worker.min.js`.
- Minified and non-minified sidecar worker output.

Observed behavior:

- No useful exception is surfaced.
- The process enters the diff-viewer spinner and stalls at partial progress, commonly around `Highlighting diffs (4/8)`, `5/8`, or `7/8`.
- Killing the PTY is required to recover.

Conclusion:

- Bun compiled executable + `worker_threads` + this real worker setup is currently not reliable enough for production use.
- Treat this as waiting on upstream Bun behavior or a different worker architecture.

Current mitigation:

- Compiled Bun runtime is detected in `src/cli/worker.ts`.
- `getGenericWorkerUrl()` returns `null` there.
- The diff viewer falls back to running full-file highlighting on the main thread instead of offloading to workers, which is slower but avoids hangs.

## Finding 3: Passing `URL` Objects To Bun Workers Can Crash Cleanup

While testing file worker sources in Bun test runs, passing a `URL` object directly to `new Worker()` triggered an unhandled Bun cleanup error:

```text
TypeError: revokeObjectURL expects a string
```

Mitigation implemented:

- `Threaded` normalizes `file:` URLs to filesystem paths before passing them to `new Worker()`.
- Non-file URLs remain URL objects.

## Current Runtime Matrix

| Runtime                           | Full-file threaded highlighting | Notes                                                  |
| --------------------------------- | ------------------------------- | ------------------------------------------------------ |
| `bun run start`                   | Yes                             | Uses source worker file.                               |
| `bun run start:node`              | Yes                             | Uses source worker file through `tsx`.                 |
| `node ./dist/index.js`            | Yes                             | Uses `dist/workers/generic.worker.min.js`.             |
| npm-installed `gdx` Node fallback | Yes                             | Package includes `dist/workers/generic.worker.min.js`. |
| Bun compiled binary               | No                              | Falls back to highlighting on the main thread.         |

## Future Investigation Ideas

Potential directions if full-file threaded highlighting is required in Bun compiled binaries:

- Build a self-spawned worker mode (fork itself) using the compiled binary itself and stdio IPC instead of `worker_threads`.
   - Pros: Easier to implement, harder to break across Bun versions.
   - Cons: Much more overhead than `worker_threads`, more complex IPC.
- Isolate a minimal Bun reproduction for `worker_threads` file workers in compiled executables and report upstream.
- Test whether newer Bun versions fix compiled executable worker behavior.
