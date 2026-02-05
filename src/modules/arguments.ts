export class ArgsSet extends Array<string> {
   constructor(args: string[]) {
      if (Array.isArray(args)) super(...args);
      else super(args);
   }

   /**
    * Finds the index of the specified argument in the array after the given index.
    * Supports arguments in the form `--arg` and `--arg=value`.
    * @param arg The argument to find.
    * @param from The index after which to search for the argument.
    * @returns The index of the argument, or -1 if not found.
    */
   optionIndexOf(arg: string, from: number = 0): number {
      for (let i = from; i < this.length; i++) {
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
         }
         else if (
            !valSameIdxOnly &&
            index + 1 < this.length &&
            !this[index + 1].startsWith('-')
         ) {
            // Argument is in the form --arg value
            value = this[index + 1];
            this.splice(index, 2);
         }
         else {
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
    * @param arg The argument to check for.
    * @param from The index after which to search for the argument.
    * @returns True if the argument exists after the specified index, false otherwise.
    */
   hasOption(arg: string, from: number = 0): boolean {
      for (let i = from; i < this.length; i++) {
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
