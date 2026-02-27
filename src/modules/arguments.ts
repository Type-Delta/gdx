import {
   GDX_OPTIONS_NO_VALUES,
   GDX_OPTIONS_WITH_VALUES,
   GIT_GLOBAL_OPTIONS_NO_VALUES,
   GIT_GLOBAL_OPTIONS_WITH_VALUES,
} from '@/commands/__completion.structure';

const GDX_OPTIONS_WITH_VALUES_LIST = [...GDX_OPTIONS_WITH_VALUES] as string[];
const GDX_OPTIONS_NO_VALUES_LIST = [...GDX_OPTIONS_NO_VALUES] as string[];
const GIT_GLOBAL_OPTIONS_WITH_VALUES_LIST = [...GIT_GLOBAL_OPTIONS_WITH_VALUES] as string[];
const GIT_GLOBAL_OPTIONS_NO_VALUES_LIST = [...GIT_GLOBAL_OPTIONS_NO_VALUES] as string[];

export class ArgsSet extends Array<string> {
   constructor(args: string[]) {
      if (Array.isArray(args)) super(...args);
      else super(args);
   }

   /**
    * Finds the index of the specified argument in the array after the given index.
    * Supports arguments in the form `--arg` and `--arg=value`.
    * Stops searching after the `--` terminator.
    * @param arg The argument to find.
    * @param from The index after which to search for the argument.
    * @returns The index of the argument, or -1 if not found.
    */
   optionIndexOf(arg: string, from: number = 0): number {
      const terminatorIndex = this.indexOf('--');
      if (terminatorIndex !== -1 && terminatorIndex < from) {
         return -1;
      }

      const endIndex = terminatorIndex === -1 ? this.length : terminatorIndex;
      for (let i = from; i < endIndex; i++) {
         if (this[i] === arg || this[i].startsWith(arg + '=')) {
            return i;
         }
      }
      return -1;
   }

   /**
    * Deletes the specified argument from the array.
    * @param arg The argument to delete.
    * @returns True if the argument was found and deleted, false otherwise.
    */
   delete(arg: string): boolean {
      const index = this.optionIndexOf(arg);
      if (index !== -1) {
         this.splice(index, 1);
         return true;
      }
      return false;
   }

   /**
    * Pops the value of the given argument and removes both the argument and its value from the array.
    * If the argument is in the form `--arg=value`, it extracts the value and removes only the argument.
    * @param arg The argument to pop the value for.
    * @param from The index after which to search for the argument.
    * @param valSameIdxOnly If true, only considers values in the same index (i.e., `--arg=value`).
    * @returns The value associated with the argument, or null if not found.
    */
   popValue(arg: string, from: number = 0, valSameIdxOnly: boolean = false): string | null {
      const index = this.optionIndexOf(arg, from);
      if (index !== -1) {
         let value: string | null = null;

         if (arg.includes('=')) {
            // Argument is in the form --arg=value
            value = getValueFromOption(this[index]);
            this.splice(index, 1);
         } else if (
            !valSameIdxOnly &&
            index + 1 < this.length &&
            !this[index + 1].startsWith('-')
         ) {
            // Argument is in the form --arg value
            value = this[index + 1];
            this.splice(index, 2);
         } else {
            // Argument found but no value present
            this.splice(index, 1);
         }
         return value;
      }
      return null;
   }

   /**
    * Pops the specified argument from the array.
    * @param arg The argument to pop.
    * @param from The index after which to search for the argument.
    * @returns The popped argument, or null if not found.
    */
   popOption(arg: string, from: number = 0): string | null {
      const index = this.optionIndexOf(arg, from);
      if (index !== -1) {
         this.splice(index, 1);
         return arg;
      }
      return null;
   }

   /**
    * Splices the specified argument with the provided insert array.
    * @param arg The argument to splice.
    * @param insert The array of strings to insert in place of the argument.
    * @param from The index after which to search for the argument.
    * @returns True if the argument was found and spliced, false otherwise.
    */
   spliceOption(arg: string, insert: string[], from: number = 0): boolean {
      const index = this.optionIndexOf(arg, from);
      if (index !== -1) {
         this.splice(index, 1, ...insert);
         return true;
      }
      return false;
   }

   /**
    * Checks if the specified argument exists in the array after the given index.
    * Stops searching after the `--` terminator.
    * @param arg The argument to check for.
    * @param from The index after which to search for the argument.
    * @returns True if the argument exists after the specified index, false otherwise.
    */
   hasOption(arg: string, from: number = 0): boolean {
      const terminatorIndex = this.indexOf('--');
      if (terminatorIndex !== -1 && terminatorIndex < from) {
         return false;
      }

      const endIndex = terminatorIndex === -1 ? this.length : terminatorIndex;
      for (let i = from; i < endIndex; i++) {
         if (this[i] === arg || this[i].startsWith(arg + '=')) {
            return true;
         }
      }
      return false;
   }

   slice(start?: number, end?: number): ArgsSet {
      // Override to return ArgsSet instead of Array<string>
      return new ArgsSet(super.slice(start, end));
   }

   /**
    * Converts the ArgsSet to a regular array of strings.
    *
    * This method shallow clones the ArgsSet into a new array.
    * @returns An array of strings representing the arguments.
    */
   toArray(): string[] {
      return super.slice(0);
   }
}

interface ParsedGitGlobalOption {
   consumed: number;
   gitArgs: string[];
}

function parseGitGlobalOption(args: string[], index: number): ParsedGitGlobalOption | null {
   const token = args[index];

   if (GIT_GLOBAL_OPTIONS_NO_VALUES_LIST.includes(token)) {
      return { consumed: 1, gitArgs: [token] };
   }

   for (const option of GIT_GLOBAL_OPTIONS_WITH_VALUES_LIST) {
      if (token === option) {
         if (index + 1 >= args.length) return null;
         const value = args[index + 1];
         if (value === '--') return null;
         return { consumed: 2, gitArgs: [option, value] };
      }

      if (token.startsWith(option + '=')) {
         return { consumed: 1, gitArgs: [option, token.slice(option.length + 1)] };
      }

      if (!option.startsWith('--') && token.startsWith(option) && token.length > option.length) {
         return { consumed: 1, gitArgs: [option, token.slice(option.length)] };
      }
   }

   return null;
}

/**
 * Result of stripping git global options from arguments.
 */
export interface StripGitGlobalArgsResult {
   args: string[];
   gitArgs: string[];
   cursorIndex?: number;
   cursorInGitGlobal: boolean;
}

/**
 * Strips git global options from the leading argument list before the command token.
 *
 * @param args - Raw argument list.
 * @param cursorIndex - Optional cursor index for completion adjustments.
 * @returns Stripped args, git-global args, and cursor metadata.
 */
export function stripGitGlobalArgs(args: string[], cursorIndex?: number): StripGitGlobalArgsResult {
   if (args[0] && !args[0].startsWith('-')) {
      return {
         args,
         gitArgs: [],
         cursorIndex,
         cursorInGitGlobal: false,
      };
   }

   const removeIndices = new Set<number>();
   const gitArgs: string[] = [];
   let i = 0;

   while (i < args.length) {
      const token = args[i];

      if (token === '--') break;

      const parsedGit = parseGitGlobalOption(args, i);
      if (parsedGit) {
         const start = i;
         const end = i + parsedGit.consumed - 1;

         if (cursorIndex != null && cursorIndex >= start && cursorIndex <= end) {
            return {
               args,
               gitArgs: [],
               cursorIndex,
               cursorInGitGlobal: true,
            };
         }

         if (cursorIndex == null || end < cursorIndex) {
            gitArgs.push(...parsedGit.gitArgs);
            for (let idx = start; idx <= end; idx++) {
               removeIndices.add(idx);
            }
         }

         i += parsedGit.consumed;
         continue;
      }

      if (GDX_OPTIONS_WITH_VALUES_LIST.includes(token)) {
         if (i + 1 >= args.length) break;
         i += 2;
         continue;
      }

      if (GDX_OPTIONS_NO_VALUES_LIST.includes(token)) {
         i += 1;
         continue;
      }

      if (token.startsWith('-')) {
         i += 1;
         continue;
      }

      break;
   }

   if (removeIndices.size === 0) {
      return {
         args,
         gitArgs,
         cursorIndex,
         cursorInGitGlobal: false,
      };
   }

   const strippedArgs = args.filter((_, idx) => !removeIndices.has(idx));
   let adjustedCursorIndex = cursorIndex;

   if (cursorIndex != null) {
      let removedBefore = 0;
      for (const idx of removeIndices) {
         if (idx < cursorIndex) removedBefore += 1;
      }

      adjustedCursorIndex = Math.max(0, cursorIndex - removedBefore);
      if (strippedArgs.length > 0 && adjustedCursorIndex >= strippedArgs.length) {
         adjustedCursorIndex = strippedArgs.length - 1;
      }
   }

   return {
      args: strippedArgs,
      gitArgs,
      cursorIndex: adjustedCursorIndex,
      cursorInGitGlobal: false,
   };
}

/**
 * Extracts the value from an argument in the form `--arg=value`.
 * @param option The argument string.
 * @returns The extracted value, or null if not in the correct form.
 */
export function getValueFromOption(option: string): string | null {
   const sepIdx = option.indexOf('=');
   if (sepIdx !== -1) {
      return option.substring(sepIdx + 1);
   }
   return null;
}

/**
 * Creates an ArgsSet instance from the given array of arguments.
 */
export function argsSet(args: string[]): ArgsSet {
   return new ArgsSet(args);
}
