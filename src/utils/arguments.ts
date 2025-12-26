export class ArgsSet extends Array<string> {
   constructor(args: string[]) {
      if (Array.isArray(args)) super(...args);
      else super(args);
   }

   delete(arg: string): boolean {
      const index = this.indexOf(arg);
      if (index !== -1) {
         this.splice(index, 1);
         return true;
      }
      return false;
   }

   popValue(arg: string): string | null {
      const index = this.indexOf(arg);
      if (index !== -1) {
         let value: string | null = null;

         if (index + 1 < this.length) {
            value = this[index + 1];
            this.splice(index, 2);
         }
         else if ((value = getValueFromOption(this[index]))) {
            this.splice(index, 1);
         }
         return value;
      }
      return null;
   }
}

export function getValueFromOption(option: string): string | null {
   const sepIdx = option.indexOf('=');
   if (sepIdx !== -1) {
      return option.substring(sepIdx + 1);
   }
   return null;
}

export function argsSet(args: string[]): ArgsSet {
   return new ArgsSet(args);
}
