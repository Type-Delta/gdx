import {
   GDX_OPTIONS_NO_VALUES,
   GDX_OPTIONS_WITH_VALUES,
   GIT_GLOBAL_OPTIONS_NO_VALUES,
   GIT_GLOBAL_OPTIONS_WITH_VALUES,
} from '@/consts';
import { Err } from '@lib/Tools';
import global from '../global';

const GDX_OPTIONS_WITH_VALUES_LIST = [...GDX_OPTIONS_WITH_VALUES] as string[];
const GDX_OPTIONS_NO_VALUES_LIST = [...GDX_OPTIONS_NO_VALUES] as string[];
const GIT_GLOBAL_OPTIONS_WITH_VALUES_LIST = [...GIT_GLOBAL_OPTIONS_WITH_VALUES] as string[];
const GIT_GLOBAL_OPTIONS_NO_VALUES_LIST = [...GIT_GLOBAL_OPTIONS_NO_VALUES] as string[];
const OPTION_VALUE_SEPARATOR = '=';

export class ArgsSet extends Array<string> {
   argIndexes: Map<string, number[]> = new Map();
   private indexedLength = -1;
   private indexesDirty = true;

   constructor(args: string[]) {
      // @ts-expect-error - allow dynamic super() call with array elements
      if (Array.isArray(args)) super(...args);
      else super(args);

      this.reindex();
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
      const fromIndex = normalizeFromIndex(from, this.length);
      let terminatorIndex = -1;

      if (global.indexArgs) {
         this.ensureIndexes();
         terminatorIndex = this.argIndexes.get('--')?.[0] ?? -1;
      } else {
         terminatorIndex = super.indexOf('--');
      }

      if (terminatorIndex !== -1 && terminatorIndex < fromIndex) {
         return -1;
      }

      const endIndex = terminatorIndex === -1 ? this.length : terminatorIndex;
      const argName = getIndexKey(arg);
      if (global.indexArgs && argName.startsWith('-')) {
         const indexes = this.argIndexes.get(argName);
         if (indexes && indexes.length > 0) {
            let cursor = 0;
            if (indexes.length === 1) {
               const onlyIndex = indexes[0];
               if (onlyIndex < fromIndex || onlyIndex >= endIndex) {
                  cursor = 1;
               }
            } else {
               cursor = getFirstIndexPositionAtOrAfter(indexes, fromIndex);
            }

            while (cursor < indexes.length) {
               const index = indexes[cursor];
               if (index >= endIndex) {
                  break;
               }

               if (optionTokenMatches(this[index], arg)) {
                  return index;
               }

               cursor += 1;
            }
         }
      }

      for (let i = fromIndex; i < endIndex; i++) {
         if (optionTokenMatches(this[i], arg)) {
            if (global.indexArgs && argName.startsWith('-')) {
               this.reindex();
            }
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
         const option = this[index];

         if (option.includes(OPTION_VALUE_SEPARATOR)) {
            // Argument is in the form --arg=value
            value = getValueFromOption(option);
            this.splice(index, 1);
         } else if (!valSameIdxOnly && index + 1 < this.length && isValueToken(this[index + 1])) {
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
    * Pops the value of the given argument and removes both the argument and its value from the array.
    * If the argument is in the form `--arg=value`, it extracts the value and removes only the argument.
    *
    * Throws an error if the argument is found but no value is provided.
    *
    * @param arg The argument to pop the value for.
    * @param from The index after which to search for the argument.
    * @param valSameIdxOnly If true, only considers values in the same index (i.e., `--arg=value`).
    * @returns The value associated with the argument, or null if not found.
    */
   popAssertValue(arg: string, from: number = 0, valSameIdxOnly: boolean = false): string | null {
      const index = this.optionIndexOf(arg, from);
      if (index !== -1) {
         let value: string | null = null;
         const option = this[index];

         if (option.includes(OPTION_VALUE_SEPARATOR)) {
            // Argument is in the form --arg=value
            value = getValueFromOption(option);
            this.splice(index, 1);
         } else if (!valSameIdxOnly && index + 1 < this.length && isValueToken(this[index + 1])) {
            // Argument is in the form --arg value
            value = this[index + 1];
            this.splice(index, 2);
         } else {
            // Argument found but no value present
            throw new Err(
               `Options "${this[index]}" requires a value, but none was provided.`,
               'MISSING_OPTION_VALUE'
            );
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
         const removed = this.splice(index, 1)[0];
         return removed;
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
      return this.optionIndexOf(arg, from) !== -1;
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

   splice(start: number, deleteCount?: number, ...rest: string[]): string[] {
      const oldLength = this.length;
      const result =
         arguments.length === 1
            ? super.splice(start)
            : super.splice(start, deleteCount as number, ...rest);

      if (!global.indexArgs) {
         return result;
      }

      if (this.indexesDirty || this.indexedLength !== oldLength) {
         this.reindex();
         return result;
      }

      const normalizedStart = normalizeSpliceStart(start, oldLength);
      this.updateIndexesAfterSplice(normalizedStart, result.length, rest);
      return result;
   }

   indexOf(arg: string, from: number = 0): number {
      if (!global.indexArgs || !arg.startsWith('-')) {
         return super.indexOf(arg, from);
      }

      this.ensureIndexes();

      const fromIndex = normalizeFromIndex(from, this.length);
      if (fromIndex >= this.length) {
         return -1;
      }

      const indexes = this.argIndexes.get(getIndexKey(arg));
      if (indexes && indexes.length > 0) {
         let cursor = 0;
         if (indexes.length === 1) {
            if (indexes[0] < fromIndex) {
               cursor = 1;
            }
         } else {
            cursor = getFirstIndexPositionAtOrAfter(indexes, fromIndex);
         }

         while (cursor < indexes.length) {
            const index = indexes[cursor];
            if (this[index] === arg) {
               return index;
            }
            cursor += 1;
         }
      }

      const fallback = super.indexOf(arg, fromIndex);
      if (fallback !== -1) {
         this.reindex();
      }
      return fallback;
   }

   push(...items: string[]): number {
      const oldLength = this.length;
      const result = super.push(...items);

      if (!global.indexArgs) {
         return result;
      }

      if (this.indexesDirty || this.indexedLength !== oldLength) {
         this.reindex();
         return result;
      }

      this.updateIndexesAfterSplice(oldLength, 0, items);
      return result;
   }

   pop(): string | undefined {
      if (this.length === 0) {
         return undefined;
      }

      const oldLength = this.length;
      const result = super.pop();

      if (!global.indexArgs) {
         return result;
      }

      if (this.indexesDirty || this.indexedLength !== oldLength) {
         this.reindex();
         return result;
      }

      this.updateIndexesAfterSplice(oldLength - 1, 1, []);
      return result;
   }

   shift(): string | undefined {
      if (this.length === 0) {
         return undefined;
      }

      const oldLength = this.length;
      const result = super.shift();

      if (!global.indexArgs) {
         return result;
      }

      if (this.indexesDirty || this.indexedLength !== oldLength) {
         this.reindex();
         return result;
      }

      this.updateIndexesAfterSplice(0, 1, []);
      return result;
   }

   unshift(...items: string[]): number {
      const oldLength = this.length;
      const result = super.unshift(...items);

      if (!global.indexArgs) {
         return result;
      }

      if (this.indexesDirty || this.indexedLength !== oldLength) {
         this.reindex();
         return result;
      }

      this.updateIndexesAfterSplice(0, 0, items);
      return result;
   }

   reverse(): this {
      super.reverse();
      this.reindex();
      return this;
   }

   sort(compareFn?: (a: string, b: string) => number): this {
      super.sort(compareFn);
      this.reindex();
      return this;
   }

   fill(value: string, start?: number, end?: number): this {
      super.fill(value, start, end);
      this.reindex();
      return this;
   }

   copyWithin(target: number, start: number, end?: number): this {
      super.copyWithin(target, start, end);
      this.reindex();
      return this;
   }

   /**
    * Invalidates the argument indexes, marking them as outdated. This should be called after any mutation that changes the array length or order when indexing is enabled.
    */
   invalidateIndexes(): void {
      this.argIndexes.clear();
      this.indexedLength = -1;
      this.indexesDirty = true;
   }

   /**
    * Ensures that the argument indexes are up to date if indexing is enabled.
    */
   private ensureIndexes(): void {
      if (!global.indexArgs) {
         return;
      }

      if (this.indexesDirty || this.indexedLength !== this.length) {
         this.reindex();
      }
   }

   /**
    * Updates the argument indexes after a splice operation. This method adjusts the stored indexes based on the splice parameters, removing indexes for deleted items and shifting indexes for items after the splice point. It also adds indexes for any new items that are valid options (i.e., start with '-').
    */
   private updateIndexesAfterSplice(start: number, removedCount: number, inserted: string[]): void {
      const removedEnd = start + removedCount;
      const delta = inserted.length - removedCount;

      for (const [key, indexes] of this.argIndexes) {
         if (indexes.length === 1) {
            const index = indexes[0];
            if (index >= start && index < removedEnd) {
               this.argIndexes.delete(key);
               continue;
            }

            if (index >= removedEnd) {
               indexes[0] = index + delta;
            }

            continue;
         }

         let write = 0;
         for (const index of indexes) {
            if (index < start) {
               indexes[write] = index;
               write += 1;
               continue;
            }

            if (index >= removedEnd) {
               indexes[write] = index + delta;
               write += 1;
            }
         }

         if (write === 0) {
            this.argIndexes.delete(key);
         } else {
            indexes.length = write;
         }
      }

      for (let i = 0; i < inserted.length; i++) {
         const token = inserted[i];
         if (!token.startsWith('-')) {
            continue;
         }

         const key = getIndexKey(token);
         const index = start + i;
         const indexes = this.argIndexes.get(key);
         if (!indexes) {
            this.argIndexes.set(key, [index]);
            continue;
         }

         if (indexes.length === 1) {
            if (index <= indexes[0]) {
               indexes.unshift(index);
            } else {
               indexes.push(index);
            }
            continue;
         }

         const lastIndex = indexes[indexes.length - 1];
         if (index >= lastIndex) {
            indexes.push(index);
            continue;
         }

         const insertAt = getFirstIndexPositionAtOrAfter(indexes, index);
         indexes.splice(insertAt, 0, index);
      }

      this.indexedLength = this.length;
      this.indexesDirty = false;
   }

   /**
    * Rebuilds the argument indexes from scratch by iterating over the current array. This should be called when the indexes are known to be outdated or when enabling indexing for the first time. If indexing is disabled, it simply invalidates the indexes without rebuilding.
    */
   private reindex(): void {
      if (!global.indexArgs) {
         return;
      }

      this.argIndexes.clear();
      for (let i = 0; i < this.length; i++) {
         const token = this[i];
         if (token === undefined) continue;

         if (!token.startsWith('-')) {
            continue;
         }

         const key = getIndexKey(token);
         const optionIndexes = this.argIndexes.get(key);
         if (optionIndexes) {
            optionIndexes.push(i);
         } else {
            this.argIndexes.set(key, [i]);
         }
      }

      this.indexedLength = this.length;
      this.indexesDirty = false;
   }
}

function normalizeFromIndex(from: number, length: number): number {
   if (!Number.isFinite(from)) {
      return 0;
   }

   const normalized = Math.trunc(from);
   if (normalized < 0) {
      const shifted = length + normalized;
      return shifted < 0 ? 0 : shifted;
   }

   return normalized;
}

function optionTokenMatches(token: string | undefined, arg: string): boolean {
   if (token == null) {
      return false;
   }

   if (arg.includes(OPTION_VALUE_SEPARATOR)) {
      return token === arg;
   }

   return token === arg || token.startsWith(arg + OPTION_VALUE_SEPARATOR);
}

function getIndexKey(token: string): string {
   const eqIndex = token.indexOf(OPTION_VALUE_SEPARATOR);
   return eqIndex === -1 ? token : token.slice(0, eqIndex);
}

function getFirstIndexPositionAtOrAfter(indexes: number[], from: number): number {
   let left = 0;
   let right = indexes.length;

   while (left < right) {
      const mid = (left + right) >>> 1;
      if (indexes[mid] < from) {
         left = mid + 1;
      } else {
         right = mid;
      }
   }

   return left;
}

function normalizeSpliceStart(start: number, length: number): number {
   if (!Number.isFinite(start)) {
      return 0;
   }

   if (start < 0) {
      const shifted = length + start;
      return shifted < 0 ? 0 : shifted;
   }

   return start > length ? length : start;
}

function isValueToken(token: string): boolean {
   if (token === '--') {
      return false;
   }

   if (token === '-' || !token.startsWith('-')) {
      return true;
   }

   return /^-\d+(\.\d+)?$/.test(token);
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
