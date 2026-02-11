import {
   CommandStructure,
   CommandArgNode,
   CommandArgThunk,
   CommandArgListThunk,
   CompletionThunkContext,
} from '../common/types';

export interface SuggestionResult {
   /** The suggested word, or null if no valid suggestion */
   completion: string | null;
}

export interface SuggestionsResult {
   /** All matching suggestions, sorted by preference */
   completions: string[];
}

interface NormalizedNode {
   children: Record<string, CommandArgNode | string[] | CommandArgThunk>;
   anyOf: Set<string>;
   allOf: Set<string>;
}

function isCommandArgNode(value: unknown): value is CommandArgNode {
   if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
   return true;
}

async function resolveNode(
   node: CommandArgNode | string[] | CommandArgThunk,
   ctx: CompletionThunkContext
): Promise<CommandArgNode | string[]> {
   let current: CommandArgNode | string[] | CommandArgThunk = node;
   let depth = 0;
   while (typeof current === 'function' && depth < 3) {
      try {
         current = await current(ctx);
      } catch {
         return {};
      }
      depth += 1;
   }
   if (Array.isArray(current) || isCommandArgNode(current)) return current;
   return {};
}

async function resolveList(
   value: string[] | CommandArgListThunk | undefined,
   ctx: CompletionThunkContext
): Promise<string[]> {
   if (!value) return [];
   let current: string[] | CommandArgListThunk = value;
   let depth = 0;
   while (typeof current === 'function' && depth < 3) {
      try {
         current = await current(ctx);
      } catch {
         return [];
      }
      depth += 1;
   }
   return Array.isArray(current) ? current : [];
}

async function normalizeNode(
   node: CommandArgNode | string[],
   ctx: CompletionThunkContext
): Promise<NormalizedNode> {
   if (Array.isArray(node)) {
      return {
         children: {},
         anyOf: new Set(node),
         allOf: new Set(),
      };
   }

   const children: Record<string, CommandArgNode | string[] | CommandArgThunk> = {};
   const anyOf = new Set(await resolveList(node.$anyOf, ctx));
   const allOf = new Set(await resolveList(node.$allOf, ctx));

   for (const [key, value] of Object.entries(node)) {
      if (key === '$allOf' || key === '$anyOf' || !value) continue;
      children[key] = value;
   }

   return { children, anyOf, allOf };
}

/**
 * Suggests all matching arguments based on the current command structure and history.
 *
 * @param args The list of arguments relative to the structure's root.
 * @param index The index of the argument currently being typed (cursor position).
 * @param structure The command structure definition.
 * @returns A suggestions result containing all matching candidates, sorted by preference.
 */
export async function suggestArgs(
   args: string[],
   index: number,
   structure: CommandStructure,
   ctx: Pick<CompletionThunkContext, 'git$'>
): Promise<SuggestionsResult> {
   let currentNode: CommandArgNode | string[] = structure.$root;
   const accumulatedAllOf = new Set<string>();
   const consumedAllOf = new Set<string>();

   // Tracks whether an exclusive option ($anyOf) has been used at the *current* node level.
   // This resets when we descend into a child subcommand.
   let consumedAnyOfCurrentNode = false;

   const cursorIndex = index;
   const buildCtx = (
      argIndex: number,
      mode: CompletionThunkContext['mode']
   ): CompletionThunkContext => ({
      git$: ctx.git$,
      args,
      index: argIndex,
      cursorIndex,
      mode,
   });

   // 1. Traverse history up to the current index
   for (let i = 0; i < index; i++) {
      const token = args[i];
      if (!token) continue;

      currentNode = await resolveNode(currentNode, buildCtx(i, 'history'));
      const norm = await normalizeNode(currentNode, buildCtx(i, 'history'));

      // Check for Child Transition
      if (token in norm.children) {
         // Add current level's $allOf options to accumulated set before descending
         for (const flag of norm.allOf) {
            accumulatedAllOf.add(flag);
         }

         const childNode = await resolveNode(norm.children[token], buildCtx(i, 'history'));
         currentNode = childNode;
         consumedAnyOfCurrentNode = false; // Reset for new node
         continue;
      }

      // Check $anyOf (Exclusive choice at current level)
      if (norm.anyOf.has(token)) {
         if (consumedAnyOfCurrentNode) {
            // Already consumed an exclusive choice at this node
            return { completions: [] };
         }
         consumedAnyOfCurrentNode = true;
         // Stay at current node (options are siblings)
         continue;
      }

      // Check $allOf (Local)
      if (norm.allOf.has(token)) {
         if (consumedAllOf.has(token)) return { completions: [] };
         consumedAllOf.add(token);
         continue;
      }

      // Check $allOf (Accumulated/Global)
      if (accumulatedAllOf.has(token)) {
         if (consumedAllOf.has(token)) return { completions: [] };
         consumedAllOf.add(token);
         continue;
      }

      // Token not found in structure
      if (token.startsWith('-')) {
         // Unknown flag -> Invalid history
         return { completions: [] };
      }

      // Positional argument (not in structure) -> Stay at current node, ignore
   }

   // 2. Generate candidates at the final node
   currentNode = await resolveNode(currentNode, buildCtx(index, 'suggest'));
   const norm = await normalizeNode(currentNode, buildCtx(index, 'suggest'));
   const candidates = new Set<string>();

   // Add Subcommands
   for (const key of Object.keys(norm.children)) {
      candidates.add(key);
   }

   // Add $anyOf options (only if we haven't used one yet)
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

   // 3. Filter and return all matches
   const input = args[index] || '';
   const matches = Array.from(candidates)
      .filter((c) => c.startsWith(input) && c !== input.trim())
      .sort((a, b) => a.length - b.length || a.localeCompare(b));
   // Prefer shorter matches, then alphabetical

   return { completions: matches };
}
