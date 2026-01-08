import { execa, ExecaMethod, Options, $ } from 'execa';
import path from 'path';
import { createInterface } from 'readline';

import { CheckCache, Err, ncc } from '@lib/Tools';

import { isExecutable } from '../utils/utilities';
import { Easing, radialGradient, RgbVec, rgbVec2decimal } from './graphics';
import { SpinnerOptions } from '@/common/types';
import { COLOR, GDX_RESULT_FILE, GDX_SIGNAL_CODE, SPINNER } from '@/consts';
import { getConfig } from '@/common/config';
import global from '@/global';
import { writeFile } from 'fs/promises';
import { unlink } from 'fs/promises';

export { $ } from 'execa';

/**
 * Creates an execa tag template that shares a single AbortController.
 * Calling `abort()` cancels all in-flight commands started from the returned `$`.
 */
export function createAbortableExec(options: Options = {}) {
   const controller = new AbortController();
   const _shell = execa({
      cancelSignal: controller.signal,
      ...options,
   } satisfies Options);

   return {
      $: _shell as ExecaMethod<{ stdout: 'pipe'; stderr: 'pipe' }>,
      abort: () => controller.abort(),
      signal: controller.signal,
   } as const;
}

/**
 * An execa instance configured to inherit stdout/stderr from the parent process.
 */
export const $inherit = execa({ stdout: 'inherit', stderr: 'inherit' });

/**
 * Prompts the user with a question and returns their input.
 * @param question - The question to ask the user.
 * @returns A promise that resolves to the user's input.
 */
export async function $prompt(question: string): Promise<string> {
   const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
   });

   return new Promise((resolve) => {
      rl.question(question, (answer) => {
         rl.close();
         resolve(answer.trim());
      });
   });
}

/**
 * Finds the full path of a given executable command, similar to `Bun.which()`.
 *
 * Searches in the following order:
 * 1. Direct path (if `cmd` contains separators).
 * 2. Current working directory.
 * 3. Directory of the executing script.
 * 4. Directory of the Node.js executable.
 * 5. System PATH.
 *
 * On Windows, it also checks extensions defined in `PATHEXT`.
 *
 * @param cmd - The command or executable name to find.
 * @returns A promise that resolves to the full path of the executable, or `null` if not found.
 */
export async function whichExec(cmd: string): Promise<string | null> {
   // If the command contains a path separator, check it directly
   if (cmd.includes(path.sep)) {
      const resolved = path.resolve(cmd);
      return (await isExecutable(resolved)) ? resolved : null;
   }

   const isWindows = process.platform === 'win32';
   let extensions: string[] = [''];

   if (isWindows) {
      // On Windows, try extensions from PATHEXT
      const pathExt = process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH';
      const systemExts = pathExt.split(';').filter(Boolean);

      // If cmd has an extension, try it first (empty string), then others if needed
      // But usually if it has an extension we might just want to check that.
      // However, to be safe and mimic robust behavior, we can try appending extensions too
      // unless it matches one of the executable extensions.
      extensions = ['', ...systemExts];
   }

   const searchPaths: string[] = [];
   searchPaths.push(process.cwd());

   if (process.argv[1]) {
      searchPaths.push(path.dirname(process.argv[1]));
   }

   searchPaths.push(path.dirname(process.execPath));

   if (process.env.PATH) {
      searchPaths.push(...process.env.PATH.split(path.delimiter));
   }

   // Filter unique paths to avoid redundant checks
   const uniquePaths = [...new Set(searchPaths)];

   for (const dir of uniquePaths) {
      if (!dir) continue;
      for (const ext of extensions) {
         const fullPath = path.join(dir, cmd + ext);
         if (await isExecutable(fullPath)) {
            return fullPath;
         }
      }
   }

   return null;
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
 * @param options - Configuration options for the spinner
 * @returns An object with `stop()` method to halt the spinner and restore stdout
 *
 * @example
 * const spinner = spinner({ message: 'Loading...', animateGradient: true });
 * // ... do work ...
 * spinner.stop();
 */
export function spinner(options: SpinnerOptions = {}) {
   options = {
      message: '',
      interval: 80,
      frames: SPINNER,
      animateGradient: false,
      gradientColor: COLOR.Zinc100,
      gradientColorBg: COLOR.Zinc700,
      gradientSpeed: 0.11,
      ...options,
   } satisfies Required<SpinnerOptions>;

   if (!process.stdout.isTTY) {
      return {
         stop: () => { /* no-op */ },
         options,
      };
   }

   let frameIndex = 0;
   let gradientOffset = 0;
   let isRunning = true;
   let intervalId: NodeJS.Timeout | null = null;
   const resetColor = ncc();

   // Hide cursor
   process.stdout.write('\x1b[?25l');

   const render = () => {
      if (!isRunning) return;

      // Draw spinner frame
      let frame = options.frames![frameIndex % options.frames!.length];

      // Draw message
      if (options.message) {
         if (options.animateGradient && CheckCache.supportsColor >= 3) {
            // Create animated gradient effect with easing
            const rawOffset = gradientOffset % 2;
            if (rawOffset <= 1) {
               const easedOffset = Easing.easeInOut(rawOffset);
               const gradientText = radialGradient(
                  options.message,
                  options.gradientColor as RgbVec,
                  options.gradientColorBg as RgbVec,
                  easedOffset,
                  0.3
               );
               frame += ' ' + gradientText;
            } else {
               frame +=
                  ' ' +
                  ncc(rgbVec2decimal(options.gradientColorBg as RgbVec)) +
                  options.message +
                  resetColor;
            }
            gradientOffset += options.gradientSpeed ?? 0.1;
         } else {
            frame += ' ' + options.message;
         }
      }

      // Clear the current line and move cursor to start then write frame
      process.stdout.write('\r\x1b[K' + frame);
      frameIndex++;
   };

   // Start the animation loop
   intervalId = setInterval(render, options.interval);
   render(); // Initial render

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
         // Clear line and show cursor
         process.stdout.write('\r\x1b[K\x1b[?25h');
      },
      /**
       * Spinner options reference
       */
      options,
   };
}

/**
 * Opens the specified file in the user's default editor as defined in the configuration.
 * @param filePath - The path to the file to open.
 * @throws Will throw an error if the default editor is not found.
 */
export async function openInEditor(filePath: string): Promise<void> {
   const config = await getConfig();
   const editor = config.getAll().defaultEditor;
   const editorPath = await whichExec(editor);

   if (!editorPath) {
      throw new Err(
         `Default editor "${editor}" not found in PATH. Set a valid editor in the configuration.`,
         'EDITOR_NOT_FOUND'
      );
   }

   await $inherit`${editorPath} ${filePath}`;
}

/**
 * Schedules a directory change by setting global output and exit code.
 * The calling shell integration should handle the actual directory change
 * based on these global values.
 *
 * @param targetDir - The target directory to change to. If undefined, no change is scheduled and will reset the already scheduled change.
 */
export async function scheduleChangeDir(targetDir?: string): Promise<void> {
   if (!targetDir) {
      if (GDX_RESULT_FILE) await unlink(GDX_RESULT_FILE).catch(() => { });
      global.exitCodeOverride = -1;
      return;
   }

   if (GDX_RESULT_FILE) await writeFile(GDX_RESULT_FILE, targetDir, 'utf-8');
   global.exitCodeOverride = GDX_SIGNAL_CODE;
}
