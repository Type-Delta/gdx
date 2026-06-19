# AGENTS.md

Guide for agentic coding agents working in the `gdx` repository.

> [!NOTE]
> If you notice any drift from what is described in this document, please update the document to reflect the current state of the project.

## Project Overview

`gdx` is a Git/GitHub CLI wrapper built with TypeScript and Bun. It provides intelligent shorthands, safety features, and AI-powered capabilities for Git workflows. The project uses ES modules, strict TypeScript, and Bun's runtime for testing and execution.

---

## Commit Message Conventions

Read this section when writting commit messages.

See [COMMIT_MESSAGE_CONVENTIONS.md](./docs/agent/COMMIT_MESSAGE_CONVENTIONS.md).

---

## Build, Lint, and Test Commands

```bash
bun run check   # Runs lint, typecheck, and build checks
bun run test    # Runs tests with Bun's test runner (set timeout >= 8mins)
```

### Development Setup

```bash
# Install dependencies and transpile library code
# Always run this when made changes to package.json or anything under lib/
bun run prepare-dev
```

### Running the Application

```bash
# Run with Bun (recommended for development)
bun start -- [args]

# example:
bun start -- commit auto # equal to `gdx commit auto`
```

### Testing

- Tests use Bun's built-in test runner
- Test files are named `*.spec.ts` and located in `test/`
- Tests create isolated environments in `test/env/` (auto-cleaned)
- Use `createTestEnv()` and `createGdxContext()` helpers from `@/utils/testHelper`

---

## Code Style Guidelines

### TypeScript Configuration

- **Strict mode:** Enabled
- **Path aliases:**
   - `@/*` → `./src/*`
   - `@lib/*` → `./lib/esm/*`
   - `@node/*` → `./node_modules/*`

### ESLint Rules

- `no-console: warn` (Console logging is discouraged; use `Logger` or `quickPrint` instead)
- `no-fallthrough: off` (Switch fallthrough is allowed)
- `no-control-regex: off` (Control characters in regex allowed)
- `@typescript-eslint/no-explicit-any: warn` (Any types discouraged)

### Import Conventions

```typescript
// External imports first (grouped)
import { execa, ExecaError } from 'execa';
import path from 'path';

// Library imports (@lib/*)
import { Err, ncc, yuString } from '@lib/Tools';

// Internal imports (@/*)
import { GdxContext } from '@/common/types';
import { $, $inherit, whichExec } from '@/modules/shell';
import { ArgsSet } from '@/modules/arguments';
import Logger from '@/utils/logger';

// Relative imports last (if needed)
import cmd from './commands';
```

**Import Guidelines:**

- Use path aliases instead of relative paths for cross-directory imports
- Group imports: external → library → internal → relative
- Use named imports from modules
- Default exports for command modules (e.g., `export default { help, stash, graph }`)

### Naming Conventions

**Files and Folders:**

- Use kebab-case: `cache-controller.ts`, `gdx-config.ts`
- Test files: `*.spec.ts`
- Commands: `src/commands/<command-name>.ts`
- Modules: `src/modules/<module-name>.ts`
- Utilities: `src/utils/<utility-name>.ts`

**Variables and Functions:**

- Use camelCase: `quickPrint`, `createGdxContext`, `progressiveMatch`
- Boolean variables: Use descriptive prefixes (`is`, `has`, `should`)

**Constants:**

- Use SCREAMING_SNAKE_CASE: `EXECUTABLE_NAME`, `TEMP_DIR`, `COLOR`
- Define in `src/consts.ts` for global constants

**Types and Interfaces:**

- Use PascalCase: `GdxContext`, `SpinnerOptions`, `CommandStructure`
- Prefer interfaces for object shapes
- Use type aliases for unions/intersections

**Logging:**

- `console.log` in production is NOT ALLOWED; use `Logger` for production logging and `quickPrint` for user output

### Comments and Documentation

**JSDoc for public APIs:**

Always document functions, classes, and complex types,
this includes helpers even if they are not exported.

```typescript
/**
 * Performs progressive matching of an input string against a list of candidates.
 * @param input - The input string to match.
 * @param candidates - The list of candidate strings to match against.
 * @param priorityMatch - If true, prioritizes the first matching candidate.
 * @returns An object containing the matched string, candidates, and exact match flag.
 */
function progressiveMatch(
   input: string,
   candidates: string[],
   priorityMatch = false
): ProgressiveMatchResult { ... }
```

---

## Performance Guidelines

Performance is main concern for this project, ranking from highest to lowest priority:

- ⭐⭐⭐⭐⭐ Responsiveness: the CLI should react to user input as fast as possible, if output is expected to take time, provide immediate feedback (e.g. spinner)
- ⭐⭐⭐⭐ Startup Latency: when user runs a command, it should respond as quickly as possible, especially for completion or wrapper commands like `gdx status` or `gdx add` that are expected to be fast.
- ⭐⭐ Throughput: for commands that process multiple items (e.g. `gdx parallel`)

To achieve this, consider the following:

- Module Importing: If module is large and/or less commonly used or not on a critical path for startup, consider whether it can be externalized or moved behind a real bundle/runtime boundary, else import it directly. If that module is large consider deep-importing specific functions to reduce bundle size and improve initial load time. Do not assume dynamic imports improve startup when the build still emits one bundled runtime file; see Caveats.
- Non-blocking Async: For operations that are I/O bound (e.g. git calls, file system operations), use async functions and await them in parallel when possible. Avoid `await` in a loop or sequentially when the operations can be done in parallel, don't worry about hitting system limits, there are application wide semaphores to prevent that.
- Caching: For expensive operations that are likely to be repeated (e.g. git calls), implement caching with appropriate invalidation. we already have numbers of git calls wrapper that provide caching in `src/modules/git.ts` use them or adding more as needed.
- Direct Git Plumbing: Most git commands are slow, consider using direct plumbing commands when it makes sense, or skip git and create our own substitute, there are already some helpers that did this and they are called "inline" commands and you can find them in `src/modules/git.ts`.

Cheat sheet for quick perf gains:

- Instead of `git rev-parse ...` use `revParseCached()`
- Instead of `git submodule ...` use `addSubmodule()`, `updateSubmodules()`, `deinitSubmodule()` etc.
- Instead of `git config ...` use `getGitConfigValue()`, `setGitConfigValue()`, `unsetGitConfigValue()`
- Instead of `git ...` use the cached wrappers.

---

## Testing Guidelines

**Test isolation:**

- Each test gets a fresh git repository in `test/env/`
- Config and cache are isolated per test
- ANSI colors disabled in tests
- Stdout/stderr captured in `buffer`

**Mock external dependencies:**

- LLM providers automatically use mock adapter in tests
- Shell operations can be mocked via `mock.module()`

---

## Implementation Checklist

Read this section when implementing a new command. (new `gdx <foo>`)

See [IMPLEMENT_NEW_COMMAND.md](./docs/agent/IMPLEMENT_NEW_COMMAND.md).

### Command Arguments

When handleing command-line arguments, always use the `ArgsSet` utility from `ctx.args` when possible:

```typescript
// You can manupulate ArgsSet like you do with arrays
const args = new ArgsSet(['--flag', 'value', '--option=abc']);
// But it includes helper methods:
// Pops and returns the value for --flag
const flagValue = args.popValue('--flag'); // 'value'
// Checks if --option is present
// instead of:
args.some((arg) => arg === '--option' || arg.startsWith('--option='));
// use:
const hasOption = args.hasOption('--option'); // true
```

If `ArgsSet` can not provide the necessary functionality for your use case, it is encouraged to extend/modify it to include the needed features, so that future commands can also benefit from it.

---

## Additional Notes

- **Git executable:** Always use `ctx.git$` from context (handles `-C <dir>` in tests)
- **Temp directory:** Use `TEMP_DIR` constant, not hardcoded paths
- **ANSI colors:** Use `ncc()` from `@lib/Tools` for terminal colors
- **LLM integration:** Commands using LLM should handle mock adapter in tests
- **Shell scripts:** Shell initialization scripts in `src/templates/shell.ts`
- **Completion:** Command completion structure in `src/commands/__completion.structure.ts`
- **Patch Packages:** This project uses Bun's patching system, you can find information about the currently patched packages in [patches.md](./docs/patches.md).
- Test in this project can be very slow, ALWAYS set execution timeout >= 8 minutes.

### Caveats

> The role of this section is to describe common mistakes and
> confusion points that agents might encounter as they work in
> this project. If you ever encounter something in the project
> that surprises you, please alert the developer working with you
> and indicate that this is the case in this section to help
> prevent future agents from having the same issue.

- **`lib/Tools.js` is authored as one `const Tools = { ... }` object, but the
  build emits tree-shakeable ESM.** `scripts/transform-tools.mjs` hoists every
  member of that object into its own top-level `export function` / `export const`
  and rewrites internal `Tools.x` references to bare `x`, so bundlers can drop
  unused members. Consequences when editing `lib/Tools.js`:
   - Call sibling members via `Tools.foo(...)` (never `this.foo`); `this` is not
     bound after hoisting.
   - Only regular methods and `key: value` properties are supported as direct
     members. Adding a getter/setter, spread, or computed key at the top level of
     the `Tools` object makes the transform throw on purpose — extend the
     transform if you need one.
   - Import members by name (`import { ncc } from '@lib/Tools'`). A default
     (`import Tools from`) or namespace import pulls in the whole object and
     defeats tree-shaking.
- **Dynamic imports of first-party modules often hurt performance** (more info in [DYNAMIC_IMPORTS.CAVEAT.md](./docs/agent/DYNAMIC_IMPORTS.CAVEAT.md))
- **Not having npm publish GitHub Actions workflow is actually a choice** (more info in [NPM_PUBLISH.CAVEAT.md](./docs/agent/NPM_PUBLISH.CAVEAT.md))
- **Pinned `which@2.0.2` to avoid multiple versions of `which` in the bundle**
- **Tests use custom harness: check `testHelper.ts` for details** (more info in [TEST_HARNESS.CAVEAT.md](./docs/agent/TEST_HARNESS.CAVEAT.md), read this when writing tests)
- **Post-install diagnostics are an opt-in integration suite, not a normal Bun test.** Its source is `test/post-install.validator.ts` (intentionally without `.spec.ts`/`.test.ts`).
