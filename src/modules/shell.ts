import _whichLib from 'which';
import { execa, ExecaMethod, Options, ExecaError } from 'execa';
import type { MinimalVerboseObject } from '@node/execa/types/verbose';

import { CheckCache, Err, MathKit, ex_length, ncc, yuString } from '@lib/Tools';

import { Easing, hslToRgbVec, radialGradient, RgbVec, rgbVec2decimal } from './graphics';
import { SpinnerOptions } from '@/common/types';
import { GDX_VPALETTE, GDX_RESULT_FILE, GDX_SIGNAL_CODE, DEFAULT_SPINNER, SGR } from '@/consts';
import { getConfig } from '@/common/config';
import global from '@/global';
import { getWhichExecCached } from './cache-controller';
import Logger from '@/utils/logger';

/** Environment marker inherited by every subprocess spawned through GDX. */
export const GDX_HISTORY_GUARD_ENV = { GDX_HISTORY_GUARD: '1' } as const;
import { unlinkSync, writeFileSync } from './fs';
import { escapeCmdArgs, quickPrint } from '@/utils/utilities';
import { readLine } from './line-editor';

export interface SpinnerController {
   /**
    * Stops the spinner and cleans up (can be resumed with `start()`)
    */
   stop: () => void;
   /**
    * Resumes the spinner if it was stopped. Optionally adds a new line before resuming.
    */
   start: (newline?: boolean) => void;
   /**
    * Updates the spinner message and forces a re-render to display it immediately.
    */
   setMessage: (msg: string) => void;
   /**
    * Updates the progress state of the spinner and forces a re-render to display it immediately.
    */
   updateProgress: (delta: number, total?: number) => void;
   /**
    * Spinner options reference, can be used to read or modify options on the fly (e.g. change frames or animation settings dynamically)
    */
   options: Required<SpinnerOptions>;
}

export interface RedrawTextOptions {
   /**
    * Complexity level for terminal display-width measurement.
    * @see ex_length
    */
   redundancyLv?: number;
   /**
    * String appended after the final line.
    */
   end?: string;
   /**
    * Redraw text that is still on the current terminal line.
    */
   inline?: boolean;
}

const logger = new Logger('shell');

/**
 * Wraps an execa method so every spawned subprocess occupies one global thread resource permit.
 * Option-only calls such as `$({ cwd })` return another limited execa method without acquiring.
 * @param method - The execa method to limit.
 * @returns An execa-compatible method gated by the global semaphore.
 */
function limitExeca<TOptions extends Options>(method: ExecaMethod<TOptions>): ExecaMethod<TOptions> {
   const limited = (...args: unknown[]) => {
      if (isExecaOptionsOnlyCall(args)) {
         return limitExeca((method as (...args: unknown[]) => ExecaMethod<TOptions>)(...args));
      }

      return runWithThreadResource(() =>
         (method as (...args: unknown[]) => Promise<unknown>)(...args)
      );
   };

   return limited as ExecaMethod<TOptions>;
}

/**
 * Runs a subprocess factory while holding one global thread resource permit.
 * @param spawn - The function that starts the subprocess.
 * @returns The subprocess result.
 */
async function runWithThreadResource<T>(spawn: () => Promise<T>): Promise<T> {
   await global.threadResources.acquire();
   try {
      return await spawn();
   } finally {
      global.threadResources.release();
   }
}

/**
 * Detects execa option-chaining calls, for example `$({ cwd })`.
 * @param args - The arguments passed to the execa method.
 * @returns True when the call configures execa instead of spawning a process.
 */
function isExecaOptionsOnlyCall(args: unknown[]): boolean {
   if (args.length !== 1) return false;

   const [firstArg] = args;
   if (!firstArg || typeof firstArg !== 'object') return false;

   return !Array.isArray(firstArg) && !('raw' in firstArg);
}

/**
 * Indicates if the current process is running in a TTY (interactive terminal).
 */
export const isTTY = () => process.stdout.isTTY && process.stdin.isTTY;

/**
 * `$` tag template for executing shell commands using execa.
 *
 * Configured to pipe stdout and stderr.
 */
export const $ = limitExeca(execa({
   env: GDX_HISTORY_GUARD_ENV,
   stdout: 'pipe',
   stderr: 'pipe',
   verbose: execaCustomLogger,
}));

/**
 * Creates an execa tag template that shares a single AbortController.
 * Calling `abort()` cancels all in-flight commands started from the returned `$`.
 */
export function createAbortableExec(options: Options = {}) {
   const controller = new AbortController();
   const _shell = limitExeca(execa({
      env: GDX_HISTORY_GUARD_ENV,
      cancelSignal: controller.signal,
      ...options,
      verbose: execaCustomLogger,
   } satisfies Options));

   return {
      $: _shell as ExecaMethod<{ stdout: 'pipe'; stderr: 'pipe' }>,
      abort: () => controller.abort(),
      signal: controller.signal,
   } as const;
}

/**
 * An execa instance configured to inherit stdin/stdout/stderr from the parent process.
 */
export const $inherit = limitExeca(execa({
   env: GDX_HISTORY_GUARD_ENV,
   stdin: 'inherit',
   stdout: 'inherit',
   stderr: 'inherit',
   verbose: execaCustomLogger,
}));

/**
 * Prints a styled command preview before executing an expanded wrapper command.
 * @param executable - Executable name to display.
 * @param args - Arguments that will be passed to the executable.
 */
export function printCommandExecution(executable: string, args: string[]): void {
   const colorVec = hslToRgbVec(((args.length % 6) + 1) / 8.6, 0.64, 0.5);
   quickPrint(
      SGR.dim +
      ncc(rgbVec2decimal(colorVec), 'fg') +
      `$ ${SGR.white + SGR.bright}${executable} ${escapeCmdArgs(args).join(' ')}` +
      SGR.reset
   );
}

/**
 * Prompts the user with a question and returns their input.
 * @param question - The question to ask the user.
 * @returns A promise that resolves to the user's input.
 */
export async function $prompt(question: string): Promise<string> {
   return (await readLine(question)).trim();
}

/**
 * Finds the full path of a given executable command, using a cached lookup to optimize repeated calls. If the command is not found, returns `null`.
 *
 * This is a wrapper around the `which` library that adds caching functionality.
 *
 * @param cmd - The command or executable name to find.
 * @returns A promise that resolves to the full path of the executable, or `null` if not found.
 */
export async function whichExec(cmd: string): Promise<string | null> {
   return await getWhichExecCached(cmd, async () => _whichLib(cmd, { nothrow: true }));
}

/**
 * Copies text to the system clipboard in a cross-platform manner.
 * @param text - The text to copy to the clipboard.
 * @returns A promise that resolves to true if successful, false otherwise.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
   try {
      switch (process.platform) {
         case 'win32':
            await $({ input: text })`clip`;
            return true;
         case 'darwin':
            await $({ input: text })`pbcopy`;
            return true;
         case 'linux':
            // Try xclip first, then xsel
            try {
               await $({ input: text })`xclip -selection clipboard`;
               return true;
            } catch {
               await $({ input: text })`xsel --clipboard --input`;
               return true;
            }
         default:
            return false;
      }
   } catch {
      return false;
   }
}

/**
 * Creates an animated spinner that displays in the terminal.
 *
 * Animation will immediately start unless no message is provided (quiet mode).
 * in this mode you will have to call `resume()` to start the spinner.
 *
 * @param options - Configuration options for the spinner
 * @returns An object with `stop()` method to halt the spinner and restore stdout
 *
 * @example
 * const spinnerCtrl = spinner({ message: 'Loading...', animateGradient: true });
 * // ... do work ...
 * spinnerCtrl.stop();
 */
export function spinner(options: SpinnerOptions = {}): SpinnerController {
   const isQuietStart = !options.message;
   options = {
      message: '',
      interval: 70,
      frames: DEFAULT_SPINNER as string[],
      animateGradient: false,
      gradientColor: GDX_VPALETTE.Zinc050,
      gradientColorBg: GDX_VPALETTE.Zinc400,
      gradientSpeed: 0.13,
      gradientInterval: 3,
      progress: { current: 0, total: -1 },
      widthCalculationLv: -1,
      ...options,
   } satisfies Required<SpinnerOptions>;

   if (!process.stdout.isTTY) {
      return {
         stop: () => {
            /* no-op */
         },
         start: (newline = true) => {
            if (newline) process.stdout.write('\n');
         },
         // eslint-disable-next-line @typescript-eslint/no-unused-vars
         setMessage: (msg: string) => { },
         // eslint-disable-next-line @typescript-eslint/no-unused-vars
         updateProgress: (delta: number, total?: number) => { },
         options: options as Required<SpinnerOptions>,
      };
   }

   let frameIndex = 0;
   let gradientOffset = 0;
   let isRunning = true;
   let intervalId: NodeJS.Timeout | null = null;
   let nextDraw: number = 0;
   let lastLineContent = '';

   const render = () => {
      if (!isRunning) return;

      // Draw spinner frame
      let frame = options.frames![frameIndex % options.frames!.length];
      const shouldStep = nextDraw <= performance.now();

      // Draw message
      if (options.message) {
         const lineContent = ' ' + options.message + renderProgress();
         lastLineContent = lineContent;

         if (options.animateGradient && CheckCache.supportsColor >= 3) {
            // Create animated gradient effect with easing
            const rawOffset = gradientOffset % options.gradientInterval!;
            if (rawOffset <= 1) {
               const easedOffset = Easing.easeInOut(rawOffset);
               const gradientText = radialGradient(
                  lineContent,
                  options.gradientColor as RgbVec,
                  options.gradientColorBg as RgbVec,
                  easedOffset,
                  0.3
               );
               frame += gradientText;
            } else {
               frame +=
                  ncc(rgbVec2decimal(options.gradientColorBg as RgbVec)) +
                  lineContent +
                  SGR.reset;
            }
            if (shouldStep)
               gradientOffset += options.gradientSpeed ?? 0.1;
         } else {
            frame += lineContent;
         }
      }

      redrawText(lastLineContent, frame, {
         end: '',
         inline: true,
         redundancyLv: options.widthCalculationLv
      });
      if (shouldStep) {
         frameIndex++;
         nextDraw = performance.now() + options.interval!;
      }
   };

   // Start the animation loop only if not quiet
   if (!isQuietStart) {
      intervalId = setInterval(render, options.interval);
      // Hide cursor
      process.stdout.write('\x1b[?25l');
      render(); // Initial render
   }

   return {
      /**
       * Stops the spinner and cleans up
       */
      stop: () => {
         isRunning = false;
         if (intervalId) {
            clearInterval(intervalId);
            intervalId = null;
         }
         redrawText(lastLineContent, '', {
            end: '',
            inline: true,
            redundancyLv: options.widthCalculationLv
         });
         lastLineContent = '';
         process.stdout.write('\x1b[?25h');
      },
      /**
       * Resumes the spinner if it was stopped
       */
      start: (newline = true) => {
         if (!isRunning) {
            // Hide cursor then add a new line if requested
            process.stdout.write('\x1b[?25l' + (newline ? '\n' : ''));
            lastLineContent = '';
            // Restart animation loop
            isRunning = true;
            intervalId = setInterval(render, options.interval);
         }
      },
      setMessage: (msg: string) => {
         options.message = msg;
         render(); // Force re-render to update message immediately
      },
      updateProgress: (delta: number, total?: number) => {
         if (options.progress) {
            if (total != null) {
               options.progress.total = total;
            }

            options.progress.current = MathKit.clamp(
               options.progress.current + delta,
               0,
               options.progress.total,
            );

            render(); // Force re-render to update progress immediately
         }
      },
      /**
       * Spinner options reference
       */
      options: options as Required<SpinnerOptions>,
   };

   function renderProgress(): string {
      if (!options.progress || options.progress.total <= 0 || options.progress.current < 0) return '';
      return ` (${options.progress.current}/${options.progress.total})`;
   }
}

/**
 * Opens the specified file in the user's default editor as defined in the configuration.
 * @param filePath - The path to the file to open.
 * @param editorCommand - Optional custom editor command to use instead of the default editor from configuration. This can include arguments (e.g. "code --wait") for more flexible editor launching.
 * @throws Will throw an error if the default editor is not found.
 */
export async function openInEditor(filePath: string, editorCommand?: string): Promise<void> {
   const config = await getConfig();
   const tokens = editorCommand ? tokenizeCommand(editorCommand) : [];
   const editorName = tokens.length ? tokens.shift() : config.getAll().defaultEditor;

   if (!editorName) {
      throw new Err('Editor is not configured.', 'EDITOR_NOT_CONFIGURED');
   }

   const editorPath = await whichExec(editorName);
   if (!editorPath) {
      throw new Err(
         `Editor "${editorName}" not found in PATH. Set a valid editor in the configuration.`,
         'EDITOR_NOT_FOUND'
      );
   }

   if (tokens.length)
      await $inherit`${editorPath} ${tokens} ${filePath}`;
   else await $inherit`${editorPath} ${filePath}`;
}

/**
 * Schedules a directory change by setting global output and exit code.
 * The calling shell integration should handle the actual directory change
 * based on these global values.
 *
 * @param targetDir - The target directory to change to. If undefined, no change is scheduled and will reset the already scheduled change.
 */
export function scheduleChangeDir(targetDir?: string): void {
   if (!targetDir) {
      if (GDX_RESULT_FILE) unlinkSync(GDX_RESULT_FILE);
      global.exitCodeOverride = -1;
      return;
   }

   if (GDX_RESULT_FILE) writeFileSync(GDX_RESULT_FILE, targetDir, 'utf-8');
   global.exitCodeOverride = GDX_SIGNAL_CODE;
}

/**
 * Tokenizes a command string into an argv array, respecting quotes.
 * Basic shell-like parsing: single and double quotes preserve spaces.
 * @param cmd - The command string to tokenize.
 * @returns Array of tokens.
 */
export function tokenizeCommand(cmd: string): string[] {
   const tokens: string[] = [];
   let current = '';
   let inSingleQuote = false;
   let inDoubleQuote = false;

   for (let i = 0; i < cmd.length; i++) {
      const char = cmd[i];

      if (char === "'" && !inDoubleQuote) {
         inSingleQuote = !inSingleQuote;
      } else if (char === '"' && !inSingleQuote) {
         inDoubleQuote = !inDoubleQuote;
      } else if (char === ' ' && !inSingleQuote && !inDoubleQuote) {
         if (current) {
            tokens.push(current);
            current = '';
         }
      } else {
         current += char;
      }
   }

   if (current) {
      tokens.push(current);
   }

   return tokens;
}

/**
 * Executes a command with given arguments.
 *
 * Handles optional output redirection and common process errors.
 * @param executable Executable path or command (can be array for scoped commands with flags)
 * @param args Arguments to pass to the executable
 * @param displayName Human-readable executable name for diagnostics
 * @param redirectTo Optional file path to redirect stdout
 * @param redirectMode Redirection mode: '>' (overwrite) or '>>' (append)
 * @returns Exit code of the command
 */
export async function execCommand(
   executable: string | string[],
   args: string[],
   displayName: string,
   redirectTo: string | null = null,
   redirectMode: string = '>'
): Promise<number> {
   let exitCode: number | undefined = 0;
   try {
      if (redirectTo) {
         const redirect$ = limitExeca(execa({
            env: GDX_HISTORY_GUARD_ENV,
            stdin: 'inherit',
            stdout: {
               file: redirectTo,
               append: redirectMode === '>>',
            },
            stderr: 'inherit',
         }));
         const { exitCode: eCode } = await redirect$`${executable} ${args}`;
         exitCode = eCode;
      } else {
         const { exitCode: eCode } = await $inherit`${executable} ${args}`;
         exitCode = eCode;
      }
   } catch (_err) {
      const err = Err.from(_err);
      const commandExitCode = (_err as ExecaError).exitCode;
      const signal = (_err as ExecaError).signal;
      if (signal) {
         (err as { code?: string | number }).code = signal;
      }
      if (
         err.code === 'SIGINT' ||
         err.code === 'SIGTERM' ||
         err.code === 'SIGABRT' ||
         err.code === 'SIGKILL'
      ) {
         Logger.debug(
            `${displayName} command was killed by signal: ${err.code}. Treating as failure with exit code 1.`
         );
         Logger.verbose('Full error details: ' + yuString(err, { color: true }));
         return 1; // process was killed, return 1 to indicate failure
      }

      if (err.code === 'ENOENT') {
         Logger.error(
            `${displayName} executable not found: "${executable}". Ensure ${displayName} is installed and in your PATH.`
         );
         return 1; // git not found, return 1 to indicate failure
      }

      if (err.code === 'EACCES') {
         Logger.error(
            `Permission denied when trying to execute ${displayName}: "${executable}". Check your permissions for this executable.`
         );
         return 1; // permission issue, return 1 to indicate failure
      }

      if (err.code === 'SIGPIPE') {
         Logger.debug(
            `Git command failed with SIGPIPE. This may indicate that the pipe was no longer inuse by the consumer process.`
         );
         return 1; // SIGPIPE, return 1 to indicate failure
      }

      if (err.name === ExecaError.name && err.message.startsWith('Command failed'))
         return commandExitCode ?? exitCode ?? 1; // git command failed, return exit code

      Logger.error('Command failed.\n' + yuString(err, { color: true }));
      return 1;
   }

   return exitCode ?? 0;
}

/**
 * Executes a git command with given arguments.
 *
 * Handles optional output redirection and error.
 * @param git$ Git executable path or command (can be array for test contexts with -C flag)
 * @param args Arguments to pass to git
 * @param redirectTo Optional file path to redirect stdout
 * @param redirectMode Redirection mode: '>' (overwrite) or '>>' (append)
 * @returns Exit code of the git command
 */
export async function execGit(
   git$: string | string[],
   args: string[],
   redirectTo: string | null = null,
   redirectMode: string = '>'
): Promise<number> {
   return execCommand(git$, args, 'Git', redirectTo, redirectMode);
}

/**
 * Custom logger function for execa verbose output.
 * Logs only duration events with command details.
 * @param _verboseLine - The verbose line (unused).
 * @param verboseObject - The verbose object containing event details.
 */
function execaCustomLogger(_verboseLine: string, verboseObject: MinimalVerboseObject) {
   if (verboseObject.type !== 'duration') return;
   let exitType = 'done';
   // @ts-expect-error -- known property
   if (verboseObject['result']['failed']) exitType = 'FAILED';
   // @ts-expect-error -- known property
   else if (verboseObject['result']['timedOut']) exitType = 'TIMEOUT';
   // @ts-expect-error -- known property
   else if (verboseObject['result']['isCanceled']) exitType = 'CANCELED';
   // @ts-expect-error -- known property
   else if (verboseObject['result']['isTerminated']) exitType = 'TERMINATED';

   logger.debug(
      // @ts-expect-error -- known property
      `${SGR.bright + SGR.dim}$ ${SGR.reset + verboseObject.escapedCommand + SGR.dim} (${exitType} in ${verboseObject['result']['durationMs']}ms)`
   );
}

/**
 * Estimates how many terminal rows a string occupies after automatic line wrapping.
 * @param text - The previously printed text to measure.
 * @param redundancyLv - Complexity level for terminal display-width measurement.
 * @returns The number of terminal rows occupied by the text.
 */
function estimateTerminalRowCount(text: string, redundancyLv: number): number {
   const terminalWidth = Math.floor(process.stdout.columns || global.terminalWidth || 100);
   const width = terminalWidth > 0 ? terminalWidth : 100;

   return text.split('\n').reduce((count, line) => {
      const lineWidth = ex_length(line, redundancyLv);
      return count + Math.max(1, Math.ceil(lineWidth / width));
   }, 0);
}

/**
 * Redraws text in the terminal by moving the cursor up to the start of the previous text and overwriting it with new text.
 * This is useful for updating progress messages or dynamic content without adding new lines.
 * @param prev - The previously printed text.
 * @param next - The replacement text to print.
 * @param options - Redraw behavior and display-width measurement options.
 */
export function redrawText(prev: string, next: string, options: RedrawTextOptions = {}): void {
   const { redundancyLv = -1, end = '\n', inline = false } = options;
   const originalLnCount = estimateTerminalRowCount(prev, redundancyLv);

   if (inline) {
      if (originalLnCount > 1) process.stdout.write(`\x1b[${originalLnCount - 1}F`);
      process.stdout.write('\r');
   } else {
      // Move cursor up to the start of the original message
      process.stdout.write(`\x1b[${originalLnCount}F`);
   }

   // Rewrite message line by line, clearing each line first
   const lines = next.split('\n');
   for (const [index, line] of lines.entries()) {
      const lineEnd = index === lines.length - 1 ? end : '\n';
      process.stdout.write(`\x1b[2K${line}${lineEnd}`);
   }

   if (originalLnCount > lines.length) {
      // Clear from cursor to end of screen
      process.stdout.write(`\x1b[0J`);
   }
}
