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
- `🛠️ refactor(<scope>): ...`
- `🔧 fix(<scope>): ...`
- `🧹 chore(<scope>): ...`
- `🛠️ ci(<scope>): ...`

**Body guidelines:**

- Start with 1-3 sentences describing intent/why (not just what).
- Optionally follow with a short bullet list of key changes.
- Keep lines reasonably wrapped (project uses Prettier print width 100).
- Prefer consistent bullets (no trailing periods is common in this repo).

---

## Build, Lint, and Test Commands

### Development Setup

```bash
# Install dependencies and prepare dev environment
bun run prepare-dev

# Install dependencies only
bun install
```

### Running the Application

```bash
# Run with Bun (recommended for development)
bun run start

# Run with Node.js (using tsx)
bun run start:node

# Run with CPU profiling
bun run start:profile
```

### Build Commands

```bash
# Type check only (no emit)
bun run ts-check

# Transpile to ESM (lib/esm/)
bun run transpile-esm

# Build native binary (bin/gdx)
bun run build

# Build Node.js package (dist/)
bun run package:node
```

### Linting and Formatting

```bash
# Run type check and ESLint with auto-fix
bun run lint

# Format with Prettier
bun run prettier
```

### Testing

```bash
# Run all tests
bun test

# Run specific test file
bun test test/commands/commit.spec.ts

# Run tests matching a pattern
bun test --test-name-pattern="should generate commit message"

# Run tests in watch mode
bun test --watch

# Run with coverage
bun test --coverage
```

**Note on Test Files:**

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
   ```typescript
   const hasReceivedContent = false;
   const isReasoning = false;
   const shouldWriteLogs = true;
   ```

**Constants:**

- Use SCREAMING_SNAKE_CASE: `EXECUTABLE_NAME`, `TEMP_DIR`, `COLOR`
- Define in `src/consts.ts` for global constants

**Types and Interfaces:**

- Use PascalCase: `GdxContext`, `SpinnerOptions`, `CommandStructure`
- Prefer interfaces for object shapes
- Use type aliases for unions/intersections

**Classes:**

- Use PascalCase: `Logger`, `ArgsSet`, `TestEnvTracker`

**Logging:**

- `console.log` in production is NOT ALLOWED; use `Logger` for production logging and `quickPrint` for user output

### Function Patterns

**Async Functions:**

```typescript
async function autoCommit(ctx: GdxContext): Promise<number> {
   // Always return status codes: 0 = success, 1 = error
   try {
      // ... implementation
      return 0;
   } catch (error) {
      Logger.error(yuString(error));
      return 1;
   }
}
```

**Helper Functions:**

```typescript
export function quickPrint(msg: string, end: string = '\n'): void {
   process.stdout.write(msg + end);
}
```

### Error Handling

**Use the `Err` class from @lib/Tools:**

```typescript
import { Err } from '@lib/Tools';

throw new Err('Git is not installed or not found in PATH.', 'GIT_NOT_FOUND');
```

**Use Logger for user-facing errors:**

```typescript
import Logger from '@/utils/logger';

Logger.error('No staged changes found.', 'commit');
Logger.warn('Configuration file not found, using defaults.');
Logger.info('Successfully generated commit message.');
Logger.debug('Cache hit for git version.');
```

**Status Codes:**

- Command functions should return `Promise<number>`
- Return `0` for success, `1` (or other non-zero) for errors

### Types and Interfaces

**Define context types:**

```typescript
export interface GdxContext {
   args: ArgsSet;
   git$: string | string[]; // Git executable path or command array
}
```

**Use strong typing:**

```typescript
// Good - explicit types
async function getLLMProvider(): Promise<LLMAdapter> { ... }

// Avoid - implicit any
async function getData() { ... }
```

**Optional parameters:**

```typescript
function createTestEnv(options: TestEnvOptions = { autoResetBuffer: true }) { ... }
```

### Comments and Documentation

**JSDoc for public APIs:**

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

**Inline comments for complex logic:**

```typescript
// Filter out gdx-specific flags to get pass-through args
const gdxFlags = ['auto', '--no-commit', '-nc', '--copy', '-cp'];
const passThruArgs = args.slice(1).filter((arg) => !gdxFlags.includes(arg));
```

---

## Project Structure

```
gdx/
├── src/
│   ├── commands/         # Command implementations (commit, stash, graph, etc.)
│   ├── common/           # Shared types, config, cache, adapters
│   ├── modules/          # Core modules (shell, git, fs, spellcheck, etc.)
│   ├── templates/        # Shell init scripts and prompts
│   ├── utils/            # Utilities (logger, testHelper, utilities)
│   ├── index.ts          # Main entry point
│   ├── consts.ts         # Global constants
│   └── global.ts         # Global state
├── test/
│   ├── commands/         # Command tests (*.spec.ts)
│   ├── modules/          # Module tests
│   ├── common/           # Common tests
│   └── env/              # Temporary test environments (git ignored)
├── lib/
│   └── esm/              # Transpiled library code (@lib/*)
├── scripts/              # Build and utility scripts
├── dist/                 # Node.js package output
└── bin/                  # Compiled binary output
```

---

## Testing Best Practices

**Use test helpers:**

```typescript
import { createTestEnv, createGdxContext } from '@/utils/testHelper';

describe('gdx commit auto', async () => {
   const { tmpDir, $, buffer, cleanup, it } = await createTestEnv();
   const ctx = createGdxContext(tmpDir, ['commit', 'auto']);
   afterAll(cleanup);

   it('should generate commit message', async () => {
      // Test implementation
      expect(result).toBe(0);
      expect(buffer.stdout).toContain('Generated Commit Message');
   });
});
```

**Test isolation:**

- Each test gets a fresh git repository in `test/env/`
- Config and cache are isolated per test
- ANSI colors disabled in tests
- Stdout/stderr captured in `buffer`

**Mock external dependencies:**

- LLM providers automatically use mock adapter in tests
- Shell operations can be mocked via `mock.module()`

---

## Common Patterns

### Shell Execution

```typescript
import { $, $inherit } from '@/modules/shell';

// Capture output
const result = await $`${git$} status --porcelain`;
const output = result.stdout;

// Inherit stdio (for interactive commands)
await $inherit`${git$} commit`;

// With custom working directory
const _$ = $({ cwd: tmpDir });
await _$`${git$} init`;
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

### Context Usage

```typescript
async function myCommand(ctx: GdxContext): Promise<number> {
   const { git$, args } = ctx;

   // Access arguments
   const flag = args.popValue('--flag');
   const hasOption = args.includes('--option');

   return 0;
}
```

### Configuration

```typescript
import { getConfig } from '@/common/config';

const config = await getConfig();
const value = config.get<boolean>('llm.showThinking', true); // with default
```

---

## Key Principles

1. **Return status codes** - Commands return `0` for success, `1` for errors
2. **Use path aliases** - `@/*` and `@lib/*` over relative imports
3. **Type everything** - Leverage TypeScript's strict mode
4. **Test in isolation** - Use `createTestEnv()` for clean test environments
5. **Log appropriately** - Use `Logger` for errors/warnings, `quickPrint` for output
6. **Handle errors gracefully** - Catch errors, log them, return non-zero status
7. **Follow conventions** - Consistent naming, formatting, and structure

---

## Additional Notes

- **Git executable:** Always use `ctx.git$` from context (handles `-C <dir>` in tests)
- **Temp directory:** Use `TEMP_DIR` constant, not hardcoded paths
- **ANSI colors:** Use `ncc()` from `@lib/Tools` for terminal colors
- **LLM integration:** Commands using LLM should handle mock adapter in tests
- **Shell scripts:** Shell initialization scripts in `src/templates/shell.ts`
- **Completion:** Command completion structure in `src/commands/__completion.structure.ts`
- **Quality Assurance:** Always run lint, typecheck, and tests after code changes. (you can do this mid development process so that you won't end up with a large number of errors at the end)

### Working In Temporary Worktrees

Agents may be running inside a temporary worktree under `TEMP_DIR` (used for parallel edits).
These worktrees are often in a detached HEAD state.

- Avoid `git push` from temporary worktrees,
  let humans handle pushing changes unless explicitly instructed otherwise.

**Environment Variables (Testing):**

- `GDX_CONFIG_PATH` - Custom config location
- `GDX_TEMP_DIR` - Custom temp directory
- `GIT_CONFIG_NOSYSTEM` - Disable system git config
- `GIT_CONFIG_GLOBAL` - Custom global git config
- `NODE_ENV=test` - Enables test mode

---

**Version:** 0.2.0
**Last Updated:** 2026-02-02
