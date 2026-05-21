## Commit Message Conventions

This repo commonly uses an emoji + Conventional Commits-style subject line, plus a short/detailed explanatory body. body is optional but recommended for anything more complex than a trivial change.

**Subject format:**

```text
<emoji> <type>(<scope>): <summary>
```

**Common emojis/types used in this repo:**

- `💫 feat(<scope>): ...`
- `🔧 refactor(<scope>): ...`
- `🛠️ fix(<scope>): ...`
- `🧹 chore(<scope>): ...`
- `⚙️ ci(<scope>): ...`
- `📃 docs(<scope>): ...`

**Mixed types and scopes are also allowed, e.g.**

- `💫 feat+refactor(<scope>): ...`
- `🧹 chore+fix(scope1+scope2): ...`

**Example commit message /w body:**

```text
🛠️ fix(worker+threaded): Resolve embedded modules in compiled bun workers

Implement worker resolution mechanism for different runtime environments.
Create separate generic worker file that can be properly bundled and compiled
independently.

- Add getGenericWorkerUrl() to resolve worker module for source, packaged
Node, and sidecar runtimes
- Create generic.worker.ts as standalone bundled worker implementation
- Add normalizeWorkerSource() and normalizeWorkerUrl() for flexible worker
instantiation
- Extend Threaded with workerSource option to accept external file-based
workers
- Add special handling for compiled bun executables to avoid hanging on worker
module loading
- Update build process to compile worker file separately and include in
distribution
```
