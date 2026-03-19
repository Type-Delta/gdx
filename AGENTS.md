# AGENTS.md

Guide for agentic coding agents working in the `gdx` repository.

## Project Overview

`gdx` is a Git CLI wrapper built with TypeScript and Bun. It provides intelligent shorthands, safety features, and AI-powered capabilities for Git workflows. The project uses ES modules, strict TypeScript, and Bun's runtime for testing and execution.

---

## Commit Message Conventions

This repo commonly uses an emoji + Conventional Commits-style subject line, plus a short explanatory body.

**Subject format:**

```text
<emoji> <type>(<scope>): <short imperative summary>
```

**Common emojis/types used in this repo:**

- `💫 feat(<scope>): ...`
- `🔧 refactor(<scope>): ...`
- `🛠️ fix(<scope>): ...`
- `🧹 chore(<scope>): ...`
- `⚙️ ci(<scope>): ...` (or other)

---

## Build, Lint, and Test Commands

```bash
bun run check   # Runs lint, typecheck, and build checks
bun test        # Runs tests with Bun's test runner
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

- **Target:** ES2021
- **Module:** ES2022 (ESM only)
- **Strict mode:** Enabled
- **Path aliases:**
   - `@/*` → `./src/*`
   - `@lib/*` → `./lib/esm/*`

### Formatting (Prettier)

- **Semi-colons:** Required
- **Quotes:** Single quotes (`'`)
- **Print width:** 100 characters
- **Tab width:** 3 spaces
- **Trailing commas:** ES5 style
- **Line endings:** LF (not CRLF, despite Windows repo)

### ESLint Rules

- `no-console: warn` (Console logging is discouraged; use `Logger` or `quickPrint` instead)
- `no-fallthrough: off` (Switch fallthrough is allowed)
- `no-control-regex: off` (Control characters in regex allowed)
- `@typescript-eslint/no-explicit-any: warn` (Any types discouraged but not blocked)

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

- Use path aliases (`@/*`, `@lib/*`) instead of relative paths for cross-directory imports
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
export function progressiveMatch(
   input: string,
   candidates: string[],
   priorityMatch = false
): ProgressiveMatchResult { ... }
```

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

### Implemanting a new command

1. consider implementation location: if the command is simple implement it directly in `dispatch.ts`, otherwise create a new file under `src/commands/` with the command name and export the command function as default export.
2. add and export command structure for completion in the same file (for simple commands add this in `__completion.structure.ts`)
3. [complex command] add and export help messages
4. [complex command] add the command to `src/commands/index.ts` for export
5. add tests for the command in `test/` (if it's a simple command, you can add the test in `dispatch.spec.ts`, otherwise create a new test file with the same name as the command under `test/commands/`)
6. [simple command] update global help message in `help.ts` to include the new command

## Common Patterns

### Shell Execution Patterns

```typescript
import { $, $inherit } from '@/modules/shell';

// Capture output
const result = await $`${git$} status --porcelain`;
const output = result.stdout;

// Inherit stdio
await $inherit`${git$} commit`;

// Abortable execution
const exec = createAbortableExec();
const $ = exec.$;
const result = await $`${git$} long-running-command`;
exec.abort(); // to abort if needed
```

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

### Caveats

> The role of this section is to describe common mistakes and
> confusion points that agents might encounter as they work in
> this project. If you ever encounter something in the project
> that surprises you, please alert the developer working with you
> and indicate that this is the case in this section to help
> prevent future agents from having the same issue.
