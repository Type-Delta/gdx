import { CommandStructure, CommandArgNode } from '../common/types';

export interface SuggestionResult {
   /** The suggested word, or null if no valid suggestion */
   completion: string | null;
}

interface NormalizedNode {
   children: Record<string, CommandArgNode | string[]>;
   anyOf: Set<string>;
   allOf: Set<string>;
}

function normalizeNode(node: CommandArgNode | string[]): NormalizedNode {
   if (Array.isArray(node)) {
      return {
         children: {},
         anyOf: new Set(node),
         allOf: new Set(),
      };
   }

   const children: Record<string, CommandArgNode | string[]> = {};
   const anyOf = new Set(node.$anyOf || []);
   const allOf = new Set(node.$allOf || []);

   for (const [key, value] of Object.entries(node)) {
      if (key === '$allOf' || key === '$anyOf') continue;
      children[key] = value;
   }

   return { children, anyOf, allOf };
}

/**
 * Suggests the next argument based on the current command structure and history.
 *
 * @param args The list of arguments relative to the structure's root (excluding the command name if structure is for the command content).
 * @param index The index of the argument currently being typed (cursor position).
 * @param structure The command structure definition.
 * @returns A suggestion result containing the best match or null.
 */
export function suggestArg(
   args: string[],
   index: number,
   structure: CommandStructure
): SuggestionResult {
   let currentNode: CommandArgNode | string[] = structure.$root;
   const accumulatedAllOf = new Set<string>();
   const consumedAllOf = new Set<string>();

   // Tracks whether an exclusive option ($anyOf) has been used at the *current* node level.
   // This resets when we descend into a child subcommand.
   let consumedAnyOfCurrentNode = false;

   // 1. Traverse history up to the current index
   for (let i = 0; i < index; i++) {
      const token = args[i];
      if (!token) continue;

      const norm = normalizeNode(currentNode);

      // Check for Child Transition
      if (token in norm.children) {
         // Add current level's $allOf options to accumulated set before descending
         for (const flag of norm.allOf) {
            accumulatedAllOf.add(flag);
         }

         currentNode = norm.children[token];
         consumedAnyOfCurrentNode = false; // Reset for new node
         continue;
      }

      // Check key-value pairs in structural children?
      // The structure defines keys. If token matches a key, we go there.

      // Check $anyOf (Exclusive choice at current level)
      if (norm.anyOf.has(token)) {
         if (consumedAnyOfCurrentNode) {
            // Already consumed an exclusive choice at this node
            return { completion: null };
         }
         consumedAnyOfCurrentNode = true;
         // Stay at current node (options are siblings)
         continue;
      }

      // Check $allOf (Local)
      if (norm.allOf.has(token)) {
         if (consumedAllOf.has(token)) return { completion: null };
         consumedAllOf.add(token);
         continue;
      }

      // Check $allOf (Accumulated/Global)
      if (accumulatedAllOf.has(token)) {
         if (consumedAllOf.has(token)) return { completion: null };
         consumedAllOf.add(token);
         continue;
      }

      // Token not found in structure
      if (token.startsWith('-')) {
         // Unknown flag -> Invalid history
         return { completion: null };
      }

      // Positional argument (not in structure) -> Stay at current node, ignore
   }

   // 2. Generate candidates at the final node
   const norm = normalizeNode(currentNode);
   const candidates = new Set<string>();

   // Add Subcommands
   // (Allowed even if $anyOf was used? Structure semantics imply YES: "foo --opt subcommand")
   for (const key of Object.keys(norm.children)) {
      candidates.add(key);
   }

   // Add $anyOf options
   // Only if we haven't used one yet (they are mutually exclusive)
   if (!consumedAnyOfCurrentNode) {
      for (const opt of norm.anyOf) {
         candidates.add(opt);
      }
   }

   // Add $allOf options (Local + Accumulated)
   const allAvailable = new Set([...norm.allOf, ...accumulatedAllOf]);
   for (const opt of allAvailable) {
      if (!consumedAllOf.has(opt)) {
         candidates.add(opt);
      }
   }

   // 3. Filter and select best match
   const input = args[index] || '';
   const matches = Array.from(candidates)
      .filter(c => c.startsWith(input))
      .sort((a, b) => a.length - b.length || a.localeCompare(b));
   // Prefer shorter matches, then alphabetical

   if (matches.length === 0) {
      return { completion: null };
   }

   return { completion: matches[0] };
}
