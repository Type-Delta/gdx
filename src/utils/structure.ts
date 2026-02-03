import { CommandArgNode } from "@/common/types";

/**
 * Creates a command argument node with the given options as children.
 * Each option will be a key in the returned object with an empty object as its value.
 */
export function createOptionChildren(options: string[]): CommandArgNode {
   const children: CommandArgNode = {};
   const uniqueOptions = Array.from(new Set(options));

   for (const option of uniqueOptions) {
      if (!option) continue;
      children[option] = {};
   }

   return children;
};

/**
 * Creates a command argument node with the given options as children.
 * Each option will be a key in the returned object with the provided flags as its value.
 */
export function createOptionChildrenWithFlags(
   options: string[],
   flags: string[],
   flagOperator: '$anyOf' | '$allOf' = '$allOf'
): CommandArgNode {
   const children: CommandArgNode = {};
   const uniqueOpts = Array.from(new Set(options));

   for (const option of uniqueOpts) {
      if (!option) continue;
      children[option] = { [flagOperator]: flags };
   }

   return children;
};
