import { strWrap } from '@lib/Tools';

import { getConfig } from '@/common/config';
import { CommandHelpObj, CommandStructure, GdxContext } from '@/common/types';
import { EXECUTABLE_NAME, SGR } from '@/consts';
import { ArgsSet } from '@/modules/arguments';
import { formatTable } from '@/modules/graphics';
import {
   getHistoryObserverHookStatus,
   importHistoryObserverSpool,
   installHistoryObserverHook,
   reconcileHistoryReflogs,
   runHistoryObserverHookEntry,
   uninstallHistoryObserverHook,
} from '@/modules/history/observer';
import {
   DEFAULT_HISTORY_MAX_ENTRIES,
   listHistoryTransactions,
   pruneHistory,
   readHistoryRepositoryState,
   readHistoryTimeline,
   resolveHistoryTransaction,
} from '@/modules/history/storage';
import {
   HistoryDivergence,
   HistoryDivergenceError,
   redoHistory,
   undoHistory,
} from '@/modules/history/transaction';
import { HistoryTransactionManifest, HistoryWorktreeRegistration } from '@/modules/history/types';
import Logger from '@/utils/logger';
import litedent from '@/utils/litedent';
import { progressiveMatch, quickPrint } from '@/utils/utilities';

const DEFAULT_LIST_LIMIT = 20;
const PUBLIC_SUBCOMMANDS = ['list', 'show', 'undo', 'redo', 'hook', 'unhook', 'status', 'prune'];
const INTERNAL_HOOK_ENTRY = '__hook-entry';

interface HistoryListEntry {
   manifest: HistoryTransactionManifest;
   selector: string;
   state: 'applied' | 'redo';
   worktree: string;
}

interface HistoryTimelineDisplayEntry {
   manifest: HistoryTransactionManifest;
   index: number;
   selector: string;
   state: 'applied' | 'redo';
}

/**
 * Lists and restores repository-local transaction history and manages its observer hook.
 * @param ctx - GDX execution context.
 * @returns Exit code.
 */
export default async function history(ctx: GdxContext): Promise<number> {
   const args = ctx.args.slice(0);
   const input = args[1]?.toLowerCase() ?? '';

   if (input === INTERNAL_HOOK_ENTRY) return await handleHookEntry(args);

   try {
      await reconcileDirectHistory(ctx);

      const isImplicitList = input === '' || input.startsWith('-');
      const matchResult = isImplicitList
         ? { match: 'list', candidates: null }
         : progressiveMatch(input, PUBLIC_SUBCOMMANDS);

      switch (matchResult.match) {
         case 'list':
            return await listCommand(ctx, args, isImplicitList ? 1 : 2);
         case 'show':
            return await showCommand(ctx, args);
         case 'undo':
            return await moveCommand(ctx, args, 'undo');
         case 'redo':
            return await moveCommand(ctx, args, 'redo');
         case 'hook':
            return await hookCommand(ctx, args);
         case 'unhook':
            return await unhookCommand(ctx, args);
         case 'status':
            return await statusCommand(ctx, args);
         case 'prune':
            return await pruneCommand(ctx, args);
         default:
            if (matchResult.candidates?.length) {
               Logger.warn(
                  `Ambiguous history command '${input}'. Did you mean one of: ${matchResult.candidates.join(', ')}?`,
                  'history'
               );
            } else {
               Logger.error(`Unknown history command '${input}'.`, 'history');
            }
            quickPrint(help.usage());
            return 1;
      }
   } catch (error) {
      if (error instanceof HistoryDivergenceError) {
         printDivergence(error.divergence);
      } else {
         Logger.error(error instanceof Error ? error.message : String(error), 'history');
      }
      return 1;
   }
}

/**
 * Reconciles direct Git reflog activity before a user-facing history operation.
 * Reconciliation failure is non-fatal because already-recorded history remains usable.
 * @param ctx - Direct user command context.
 */
async function reconcileDirectHistory(ctx: GdxContext): Promise<void> {
   try {
      await reconcileHistoryReflogs(ctx);
      const config = await getConfig();
      await importHistoryObserverSpool(
         ctx,
         config.get<number>('history.maxEntries', DEFAULT_HISTORY_MAX_ENTRIES)
      );
   } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      Logger.warn(
         `Could not reconcile Git reflogs: ${reason} History may omit recent external Git operations.`,
         'history'
      );
   }
}

/**
 * Runs the observer's fail-open hook entry without entering direct-command reconciliation.
 * @param args - Mutable history arguments.
 * @returns Always zero so observer bookkeeping cannot fail the originating Git command.
 */
async function handleHookEntry(args: ArgsSet): Promise<number> {
   try {
      const observerDir = args.popValue('--observer-dir', 2);
      const phase = args.slice(2).find((argument) => !argument.startsWith('-'));
      if (observerDir && phase) {
         await runHistoryObserverHookEntry(phase, { observerDir });
      }
   } catch {
      // Reference-transaction observation is deliberately fail-open.
   }
   return 0;
}

/** Runs the list/default command after parsing list-only options. */
async function listCommand(ctx: GdxContext, args: ArgsSet, optionStart: number): Promise<number> {
   const hasLimit = args.hasOption('--limit', optionStart);
   const limitValue = hasLimit ? args.popAssertValue('--limit', optionStart) : null;
   const allWorktrees = args.popOption('--all-worktrees', optionStart) !== null;
   const remaining = args.slice(optionStart);
   if (remaining.length > 0) {
      throw new Error(`Unexpected history list argument: ${remaining[0]}`);
   }

   const limit =
      limitValue === null ? DEFAULT_LIST_LIMIT : parsePositiveInteger(limitValue, 'limit');
   const entries = await collectListEntries(ctx, allWorktrees);
   const visible = entries
      .sort(
         (left, right) =>
            right.manifest.createdAt.localeCompare(left.manifest.createdAt) ||
            right.manifest.id.localeCompare(left.manifest.id)
      )
      .slice(0, limit);

   if (!visible.length) {
      quickPrint(`${SGR.yellow}No history transactions found.${SGR.reset}`);
      return 0;
   }

   const header = ['#', 'State', 'Created', 'Source', 'ID', 'Command'];
   if (allWorktrees) header.push('Worktree');
   const rows = visible.map((entry) => {
      const command = formatCommand(entry.manifest);
      const row = [
         `${SGR.cyan}${entry.selector}${SGR.reset}`,
         entry.state,
         formatDate(entry.manifest.createdAt),
         entry.manifest.source,
         entry.manifest.id.slice(0, 7),
         command ? `${SGR.dim}${command}${SGR.reset}` : '',
      ];
      if (allWorktrees) row.push(`${SGR.dim}${entry.worktree}${SGR.reset}`);
      return row;
   });
   quickPrint(
      formatTable([header.map((label) => `${SGR.bright}${label}${SGR.reset}`), ...rows], {
         padding: [0, 2, 0, 0],
         borderStyle: 'none',
         redundancyLv: 0,
      })
   );
   if (entries.length > visible.length) {
      quickPrint(
         `${SGR.dim}Showing ${visible.length} of ${entries.length}; use --limit <n> to show more.${SGR.reset}`
      );
   }
   return 0;
}

/** Collects current- or repository-wide worktree entries with per-worktree selectors. */
async function collectListEntries(
   ctx: GdxContext,
   allWorktrees: boolean
): Promise<HistoryListEntry[]> {
   if (!allWorktrees) return await entriesForWorktree(ctx, 'current');

   const state = await readHistoryRepositoryState(ctx.git$, ctx.repository);
   if (!state || Object.keys(state.worktrees).length === 0) {
      return await entriesForWorktree(ctx, 'current');
   }

   const worktrees = Object.values(state.worktrees).sort((left, right) =>
      left.root.localeCompare(right.root)
   );
   const results = await Promise.all(
      worktrees.map(async (worktree) => {
         try {
            return await entriesForWorktree(contextForWorktree(ctx, worktree), worktree.root);
         } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            Logger.warn(
               `Could not read history for worktree ${worktree.root}: ${reason}`,
               'history'
            );
            return [];
         }
      })
   );
   return results.flat();
}

/** Loads one worktree timeline and attaches stable all-scope relative selectors. */
async function entriesForWorktree(ctx: GdxContext, label: string): Promise<HistoryListEntry[]> {
   const entries = await timelineDisplayEntries(ctx);
   return entries.map((entry) => ({
      manifest: entry.manifest,
      selector: entry.selector,
      state: entry.state,
      worktree: label,
   }));
}

/** Loads timeline entries and numbers only entries that can be restored. */
async function timelineDisplayEntries(ctx: GdxContext): Promise<HistoryTimelineDisplayEntry[]> {
   const [timeline, manifests] = await Promise.all([
      readHistoryTimeline(ctx.git$, ctx.repository),
      listHistoryTransactions(ctx.git$, ctx.repository),
   ]);
   const byId = new Map(manifests.map((manifest) => [manifest.id, manifest]));
   const selectors = new Map<string, string>();
   let undoableIndex = 0;

   for (let index = timeline.entries.length - 1; index >= 0; index--) {
      const manifest = byId.get(timeline.entries[index]);
      if (!manifest) continue;
      if (canRestoreHistoryTransaction(manifest)) {
         selectors.set(manifest.id, `${undoableIndex}`);
         undoableIndex++;
      } else {
         selectors.set(manifest.id, '-');
      }
   }

   return timeline.entries.flatMap((id, index) => {
      const manifest = byId.get(id);
      if (!manifest) return [];
      return [
         {
            manifest,
            index,
            selector: selectors.get(id) ?? '-',
            state: index < timeline.cursor ? 'applied' : 'redo',
         },
      ];
   });
}

/** Builds a repository-aware context for a registered linked worktree. */
function contextForWorktree(ctx: GdxContext, worktree: HistoryWorktreeRegistration): GdxContext {
   const git$ = Array.isArray(ctx.git$) ? [...ctx.git$] : [ctx.git$];
   git$.push('-C', worktree.root);
   return {
      git$,
      args: ctx.args,
      repository: {
         root: worktree.root,
         gitDir: worktree.gitDir,
         commonGitDir: worktree.commonGitDir,
      },
   };
}

/** Displays all useful persisted fields for one selected transaction. */
async function showCommand(ctx: GdxContext, args: ArgsSet): Promise<number> {
   const positionals = args.slice(2);
   if (positionals.length > 1) throw new Error('Usage: gdx history show [id|index]');
   const selector = positionals[0] ?? '0';
   const selected = await resolveHistoryShowEntry(ctx, selector);
   const manifest = selected.manifest;

   quickPrint(`${SGR.bright}History transaction${SGR.reset}`);
   quickPrint(`ID: ${manifest.id}`);
   quickPrint(`Index: ${selected.selector}`);
   quickPrint(`State: ${selected.state}`);
   quickPrint(`Created: ${formatDate(manifest.createdAt)}`);
   quickPrint(`Source: ${manifest.source}`);
   quickPrint(`Capability: ${manifest.capability}`);
   if (manifest.command) {
      quickPrint(`Command: ${manifest.command.command}`);
      quickPrint(`Arguments: ${manifest.command.argv.join(' ') || '(none)'}`);
      quickPrint(`Working directory: ${manifest.command.cwd}`);
      quickPrint(`Exit code: ${manifest.command.exitCode ?? 'unknown'}`);
   }
   quickPrint(`Changes: ${formatChangeSummary(manifest)}`);
   if (manifest.undoUnavailableReason) {
      quickPrint(
         `${SGR.yellow}Restoration unavailable: ${manifest.undoUnavailableReason}${SGR.reset}`
      );
      quickPrint(
         `${SGR.dim}Inspect the affected refs/files manually; this entry is retained for audit only.${SGR.reset}`
      );
   }
   return 0;
}

/** Resolves history show selectors with numeric indexes matching the list output. */
async function resolveHistoryShowEntry(
   ctx: GdxContext,
   selector: string
): Promise<HistoryTimelineDisplayEntry> {
   const relativeMatch = /^~?(\d+)$/.exec(selector);
   if (relativeMatch) {
      const index = Number(relativeMatch[1]);
      const entries = (await timelineDisplayEntries(ctx)).slice().reverse();
      const entry = entries.filter((candidate) => candidate.selector !== '-')[index];
      if (!entry) throw new Error(`History selector ${selector} is outside the undoable timeline.`);
      return entry;
   }

   const manifest = await resolveHistoryTransaction(ctx.git$, selector, {
      scope: 'all',
      repository: ctx.repository,
   });
   const entries = await timelineDisplayEntries(ctx);
   const entry = entries.find((candidate) => candidate.manifest.id === manifest.id);
   if (entry) return entry;
   return {
      manifest,
      index: -1,
      selector: '-',
      state: 'redo',
   };
}

/** Parses and executes a multi-step undo or redo. */
async function moveCommand(
   ctx: GdxContext,
   args: ArgsSet,
   direction: 'undo' | 'redo'
): Promise<number> {
   const positionals = args.slice(2);
   if (positionals.length > 1) {
      throw new Error(`Usage: gdx history ${direction} [count]`);
   }
   const count = positionals.length ? parsePositiveInteger(positionals[0], 'count') : 1;
   const completed =
      direction === 'undo'
         ? await undoHistory(ctx, { count })
         : await redoHistory(ctx, { count });
   if (!completed.length) {
      quickPrint(`${SGR.yellow}Nothing to ${direction}.${SGR.reset}`);
      return 0;
   }

   quickPrint(
      `${SGR.green}${direction === 'undo' ? 'Undid' : 'Redid'} ${completed.length} history ` +
         `${completed.length === 1 ? 'transaction' : 'transactions'}.${SGR.reset}`
   );
   for (const manifest of completed) {
      const action = formatCommand(manifest);
      quickPrint(
         `  ${SGR.dim}${manifest.id.slice(0, 7)}${SGR.reset}${action ? ` ${action}` : ''}`
      );
   }
   return 0;
}

/** Returns whether a transaction is intended to participate in undo/redo indexes. */
function canRestoreHistoryTransaction(manifest: HistoryTransactionManifest): boolean {
   return manifest.capability !== 'audit-only' && !manifest.undoUnavailableReason;
}

/** Prints actionable stale-state guidance for a refused restoration. */
function printDivergence(divergence: HistoryDivergence): void {
   const surfaces = divergence.surfaces.join(', ');
   Logger.error(
      `Cannot ${divergence.direction} ${divergence.transaction.id}: repository ${surfaces} ` +
         'diverged from the recorded boundary.',
      'history'
   );
   quickPrint(
      `${SGR.yellow}Inspect with ${EXECUTABLE_NAME} history show ${divergence.transaction.id}. ` +
         `Undo/redo left the history cursor unchanged.${SGR.reset}`
   );
}

/** Installs the managed repository observer hook. */
async function hookCommand(ctx: GdxContext, args: ArgsSet): Promise<number> {
   assertNoArguments(args, 2, 'hook');
   const status = await installHistoryObserverHook(ctx);
   printObserverStatus(status.state, status.message, status.hookPath);
   return 0;
}

/** Removes the managed repository observer hook. */
async function unhookCommand(ctx: GdxContext, args: ArgsSet): Promise<number> {
   assertNoArguments(args, 2, 'unhook');
   const status = await uninstallHistoryObserverHook(ctx);
   printObserverStatus(status.state, status.message, status.hookPath);
   return 0;
}

/** Reports the managed observer state without mutating hooks. */
async function statusCommand(ctx: GdxContext, args: ArgsSet): Promise<number> {
   assertNoArguments(args, 2, 'status');
   const config = await getConfig();
   quickPrint(
      `${SGR.cyan}GDX recording: ${config.get<boolean>('history.enabled') ? 'enabled' : 'disabled'}${SGR.reset}`
   );
   const status = await getHistoryObserverHookStatus(ctx);
   printObserverStatus(status.state, status.message, status.hookPath);
   return 0;
}

/** Prunes the current timeline to the configured retention limit. */
async function pruneCommand(ctx: GdxContext, args: ArgsSet): Promise<number> {
   assertNoArguments(args, 2, 'prune');
   const config = await getConfig();
   const maxEntries = config.get<number>('history.maxEntries', DEFAULT_HISTORY_MAX_ENTRIES);
   const result = await pruneHistory(ctx.git$, maxEntries, ctx.repository);
   quickPrint(
      result.prunedIds.length
         ? `${SGR.green}Pruned ${result.prunedIds.length} history transaction${result.prunedIds.length === 1 ? '' : 's'}.${SGR.reset}`
         : `${SGR.cyan}History already satisfies the ${maxEntries}-transaction retention limit.${SGR.reset}`
   );
   return 0;
}

/** Prints the observer state plus its actionable provider message. */
function printObserverStatus(state: string, message: string, hookPath: string | null): void {
   quickPrint(`${SGR.cyan}Observer: ${state}${SGR.reset}`);
   quickPrint(message);
   if (hookPath) quickPrint(`${SGR.dim}Hook: ${hookPath}${SGR.reset}`);
}

/** Rejects unexpected subcommand arguments. */
function assertNoArguments(args: ArgsSet, from: number, subcommand: string): void {
   const remaining = args.slice(from);
   if (remaining.length) throw new Error(`Usage: gdx history ${subcommand}`);
}

/** Parses a strict positive integer option or positional. */
function parsePositiveInteger(value: string, label: string): number {
   if (!/^\d+$/.test(value)) throw new Error(`History ${label} must be a positive integer.`);
   const parsed = Number(value);
   if (!Number.isSafeInteger(parsed) || parsed < 1) {
      throw new Error(`History ${label} must be a positive integer.`);
   }
   return parsed;
}

/** Creates a compact command label for list output. */
function formatCommand(manifest: HistoryTransactionManifest): string {
   if (manifest.command?.command) return manifest.command.command;
   if (manifest.undoUnavailableReason) return manifest.undoUnavailableReason;
   return manifest.refs.length
      ? `${manifest.refs.length} ref change${manifest.refs.length === 1 ? '' : 's'}`
      : '';
}

/** Formats a stored ISO timestamp as a compact local-time string. */
function formatDate(value: string): string {
   const date = new Date(value);
   if (Number.isNaN(date.getTime())) return value;
   const pad = (part: number) => String(part).padStart(2, '0');
   return (
      `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
      `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
   );
}

/** Summarizes persisted restoration surfaces for show output. */
function formatChangeSummary(manifest: HistoryTransactionManifest): string {
   const changes = [`${manifest.refs.length} refs`];
   if (manifest.head) changes.push('HEAD');
   if (manifest.index) changes.push('index');
   if (manifest.paths?.length) changes.push(`${manifest.paths.length} paths`);
   if (manifest.control) changes.push('control state');
   return changes.join(', ');
}

export const help = {
   long: () =>
      strWrap(
         litedent`
         ${SGR.bright}HISTORY${SGR.reset}
         Inspect and restore GDX's repository-local transaction journal.

         ${EXECUTABLE_NAME} history lists the current worktree newest first. Each entry has a stable
         transaction ID and an index such as 0 (0 is newest). Use --all-worktrees to include every
         registered linked worktree and --limit <n> to change the 20-entry display limit.

         Undo and redo refuse stale repository state without moving the history cursor. Hook
         management installs a repository-local reference-transaction observer while preserving
         any existing hook.
         `,
         100,
         { firstIndent: '  ', indent: '  ', mode: 'softboundary' }
      ),
   short: 'Inspect, undo, and redo repository-local Git transactions.',
   usage: () =>
      strWrap(
         litedent`
         ${SGR.cyan}${EXECUTABLE_NAME} history [list] ${SGR.dim}[--limit <n>] [--all-worktrees]${SGR.reset}
         ${SGR.cyan}${EXECUTABLE_NAME} history show ${SGR.dim}[id|index]${SGR.reset}
         ${SGR.cyan}${EXECUTABLE_NAME} history undo ${SGR.dim}[count]${SGR.reset}
         ${SGR.cyan}${EXECUTABLE_NAME} history redo ${SGR.dim}[count]${SGR.reset}
         ${SGR.cyan}${EXECUTABLE_NAME} history hook|unhook|status|prune${SGR.reset}
         `,
         100,
         { firstIndent: '  ', indent: '  ', mode: 'softboundary' }
      ),
} as const satisfies CommandHelpObj;

export const structure = {
   $root: {
      $allOf: ['--limit=', '--all-worktrees'],
      list: {
         $allOf: ['--limit=', '--all-worktrees'],
      },
      show: {},
      undo: {},
      redo: {},
      hook: {},
      unhook: {},
      status: {},
      prune: {},
   },
} as const satisfies CommandStructure;
