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
