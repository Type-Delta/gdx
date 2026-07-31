import litedent from 'litedent';
import path from 'path';

import { Err, strWrap, yuString } from '@lib/Tools';

import * as fs from '@/modules/fs';
import { CommandHelpObj, CommandStructure, GdxContext } from '@/common/types';
import {
   $,
   copyToClipboard,
   openInEditor,
   redrawText,
   spinner,
   SpinnerController,
   tokenizeCommand,
} from '@/modules/shell';
import { ArgsSet } from '@/modules/arguments';
import { getConfig } from '@/common/config';
import {
   assertInGitWorktree,
   expandRelativeRef,
   resolveRefShaCached,
   revParseCached,
} from '@/modules/git';
import { noop, quickPrint } from '@/utils/utilities';
import Logger from '@/utils/logger';
import { EXECUTABLE_NAME, GDX_VPALETTE, TEMP_DIR, SGR } from '@/consts';
import { _2PointGradient } from '@/modules/graphics';
import global from '@/global';
import { renderCommitMessageDiffLines } from '@/modules/diff-viewer';
import { buildCommitDiffSummary } from '@/modules/diff-summary';
import { generateAutoCommitMessage } from '@/commands/commit';

const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const WAITING_FOR_EDITOR_HINT = 'hint: waiting for your editor to close the file...';

/**
 * Git author metadata used when creating a rewritten commit.
 */
interface CommitAuthor {
   name: string;
   email: string;
   date: string;
}

interface ParsedRewordArgs {
   targetRef: string;
   mode: 'editor' | 'message' | 'auto';
   message: string | null;
   autoArgs: string[];
}

interface ParsedAutoArgs {
   shouldNoCommit: boolean;
   shouldCopy: boolean;
   shouldYes: boolean;
   shouldPreview: boolean;
   userDescription: string;
}

/**
 * Resolves the parent SHAs for a commit.
 */
async function resolveCommitParents(git$: string | string[], sha: string): Promise<string[]> {
   const { stdout } = await $`${git$} rev-list --parents -n 1 ${sha}`;
   const tokens = stdout.trim().split(/\s+/).filter(Boolean);
   return tokens.slice(1);
}

/**
 * Parses repeated `-m` / `--message` options using Git commit paragraph semantics.
 *
 * @param args - Arguments after `gdx reword`.
 * @returns Message paragraphs, remaining args, and whether a message option was present.
 */
function parseMessageOptions(args: string[]): {
   message: string | null;
   remainingArgs: string[];
   sawMessageOption: boolean;
   error: string | null;
} {
   const messageParts: string[] = [];
   const remainingArgs: string[] = [];

   for (let i = 0; i < args.length; i++) {
      const arg = args[i];

      if (arg === '-m' || arg === '--message') {
         if (i + 1 >= args.length || args[i + 1] === '--') {
            return {
               message: null,
               remainingArgs,
               sawMessageOption: true,
               error: `Option ${arg} requires a value.`,
            };
         }
         messageParts.push(args[++i]);
         continue;
      }

      if (arg.startsWith('--message=')) {
         messageParts.push(arg.slice('--message='.length));
         continue;
      }

      if (arg.startsWith('-m') && arg.length > 2) {
         messageParts.push(arg.slice(2));
         continue;
      }

      remainingArgs.push(arg);
   }

   return {
      message: messageParts.length > 0 ? messageParts.join('\n\n') : null,
      remainingArgs,
      sawMessageOption: messageParts.length > 0,
      error: null,
   };
}

/**
 * Parses `gdx reword` arguments after message options have been removed.
 *
 * @param rawArgs - Arguments after `gdx reword`.
 * @param message - Parsed explicit message, if any.
 * @returns Parsed reword target and mode.
 */
function parseRewordArgs(rawArgs: string[], message: string | null): ParsedRewordArgs | null {
   const args = [...rawArgs];
   const autoIndex = args.indexOf('auto');
   const mode: ParsedRewordArgs['mode'] = message !== null ? 'message' : autoIndex >= 0 ? 'auto' : 'editor';
   const autoArgs = autoIndex >= 0 ? args.slice(autoIndex + 1) : [];
   const positionalArgs = autoIndex >= 0 ? args.slice(0, autoIndex) : args;

   if (mode === 'auto' && autoIndex > 1) {
      return null;
   }

   if (mode !== 'auto' && positionalArgs.length > 1) {
      return null;
   }

   return {
      targetRef: positionalArgs[0] || 'HEAD',
      mode,
      message,
      autoArgs,
   };
}

/**
 * Parses options supported by `gdx reword <ref> auto`.
 *
 * @param args - Arguments after the `auto` token.
 * @returns Parsed options and any unconsumed arguments.
 */
function parseAutoArgs(args: string[]): { options: ParsedAutoArgs; remainingArgs: string[] } {
   const remainingArgs = [...args];
   const shouldNoCommit =
      popOption(remainingArgs, '--no-commit') !== null || popOption(remainingArgs, '-nc') !== null;
   const shouldCopy =
      popOption(remainingArgs, '--copy') !== null || popOption(remainingArgs, '-cp') !== null;
   const shouldYes =
      popOption(remainingArgs, '--yes') !== null || popOption(remainingArgs, '-y') !== null;
   const shouldPreview = popOption(remainingArgs, '--preview') !== null;
   const userDescriptionRaw =
      popValue(remainingArgs, '--describe') || popValue(remainingArgs, '-d') || '';

   return {
      options: {
         shouldNoCommit,
         shouldCopy,
         shouldYes,
         shouldPreview,
         userDescription: userDescriptionRaw.trim(),
      },
      remainingArgs,
   };
}

/**
 * Removes an option token from an argument array.
 *
 * @param args - Mutable argument array.
 * @param option - Option name to remove.
 * @returns The removed option token, or null.
 */
function popOption(args: string[], option: string): string | null {
   const index = args.findIndex((arg) => arg === option || arg.startsWith(option + '='));
   if (index === -1) return null;
   return args.splice(index, 1)[0];
}

/**
 * Removes an option and its value from an argument array.
 *
 * @param args - Mutable argument array.
 * @param option - Option name to remove.
 * @returns The option value, or null.
 */
function popValue(args: string[], option: string): string | null {
   const index = args.findIndex((arg) => arg === option || arg.startsWith(option + '='));
   if (index === -1) return null;

   const arg = args[index];
   if (arg.includes('=')) {
      args.splice(index, 1);
      return arg.slice(arg.indexOf('=') + 1);
   }

   if (index + 1 >= args.length || args[index + 1].startsWith('-')) {
      args.splice(index, 1);
      return null;
   }

   const value = args[index + 1];
   args.splice(index, 2);
   return value;
}

/**
 * Resolves a commit tree SHA.
 */
async function resolveCommitTree(git$: string | string[], sha: string): Promise<string> {
   const { stdout } = await $`${git$} show -s --format=%T ${sha}`;
   return stdout.trim();
}

/**
 * Resolves the original author metadata for a commit.
 */
async function resolveCommitAuthor(git$: string | string[], sha: string): Promise<CommitAuthor> {
   const format = '%an%x00%ae%x00%aI';
   const { stdout } = await $`${git$} show -s --format=${format} ${sha}`;
   const [name = '', email = '', date = ''] = stdout.trimEnd().split('\0');
   return { name, email, date };
}

/**
 * Resolves the editor command for rewording.
 */
async function resolveRewordEditor(): Promise<string> {
   const config = await getConfig();
   const override = config.get<string | null>('reword.editor', null);
   const fallback = config.getAll().defaultEditor;

   if (override && override.trim().length > 0) {
      return override.trim();
   }

   if (fallback && fallback.trim().length > 0) {
      const cmd = fallback.trim();
      const execArgs = tokenizeCommand(cmd);
      const exec = path.basename(execArgs[0], path.extname(execArgs[0]));
      if (
         (!execArgs.includes('--wait') || !execArgs.includes('-w')) &&
         ['code', 'subl', 'zed', 'mate', 'bbedit', 'nova', 'gedit'].includes(exec)
      ) {
         return execArgs[0] + ' --wait ' + execArgs.slice(1).join(' ');
      }

      return cmd;
   }

   throw new Err('No editor configured.', 'EDITOR_NOT_CONFIGURED');
}

/**
 * Creates a commit from a tree/parents tuple and message file.
 */
async function createCommitFromTree(options: {
   git$: string | string[];
   treeSha: string;
   parents: string[];
   messageFile: string;
   author: CommitAuthor;
}): Promise<string> {
   const { git$, treeSha, parents, messageFile, author } = options;
   const args = [
      'commit-tree',
      treeSha,
      ...parents.flatMap((parent) => ['-p', parent]),
      '-F',
      messageFile,
   ];
   const withAuthor = $({
      env: {
         GIT_AUTHOR_NAME: author.name,
         GIT_AUTHOR_EMAIL: author.email,
         GIT_AUTHOR_DATE: author.date,
      },
   });

   const { stdout } = await withAuthor`${git$} ${args}`;
   const nextSha = stdout.trim();
   if (!nextSha) {
      throw new Err('Failed to create rewritten commit.', 'REWORD_COMMIT_TREE_FAILED');
   }

   return nextSha;
}

/**
 * Resolves HEAD ref name for update-ref operations.
 */
async function resolveHeadRef(git$: string | string[]): Promise<string> {
   const symbolicRef = await $`${git$} symbolic-ref -q HEAD`
      .then((result) => result.stdout.trim())
      .catch(() => '');
   return symbolicRef || 'HEAD';
}

/**
 * Lists commits to replay after rewriting the target commit.
 */
async function listReplayCommits(
   git$: string | string[],
   targetSha: string,
   headSha: string
): Promise<string[]> {
   const range = `${targetSha}..${headSha}`;
   const { stdout } = await $`${git$} rev-list --reverse ${range}`;
   return stdout
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
}

/**
 * Resolves the git executable path from git$ context.
 */
function resolveGitExecutable(git$: string | string[]): string {
   if (Array.isArray(git$)) {
      return git$[0];
   }
   return git$;
}

/**
 * Rewrites the current HEAD commit message using commit-tree and returns the new commit SHA.
 * This is a simpler operation than rewriting older commits since we can just create a new commit and move HEAD.
 *
 * @param git$ - The git executable path/command array.
 * @param headSha - The current HEAD commit SHA.
 * @param messageFile - Path to the file containing the new commit message.
 * @returns The SHA of the newly created commit that replaces HEAD.
 */
async function rewriteHeadCommit(
   git$: string | string[],
   headSha: string,
   messageFile: string
): Promise<string> {
   const [treeSha, parents, author] = await Promise.all([
      resolveCommitTree(git$, headSha),
      resolveCommitParents(git$, headSha),
      resolveCommitAuthor(git$, headSha),
   ]);

   const rewrittenHead = await createCommitFromTree({
      git$,
      treeSha,
      parents,
      messageFile,
      author,
   });

   const headRef = await resolveHeadRef(git$);
   await $`${git$} update-ref ${headRef} ${rewrittenHead} ${headSha}`;
   return rewrittenHead;
}

/**
 * Rewrites a non-HEAD commit message using commit-tree + cherry-pick in a temporary worktree and returns the
 * SHAs of the newly created commits.
 *
 * @param git$ - The git executable path/command array.
 * @param targetSha - The SHA of the commit to reword (must be an ancestor of HEAD).
 * @param headSha - The current HEAD commit SHA.
 * @param messageFile - Path to the file containing the new commit message for the target commit.
 * @returns A mapping of old SHAs to new SHAs for all rewritten commits, including the target and all its descendants up to HEAD.
 */
async function rewriteOlderCommit(
   git$: string | string[],
   targetSha: string,
   headSha: string,
   messageFile: string
): Promise<Record<string, string>> {
   await fs.mkdir(TEMP_DIR, { recursive: true });

   const worktreeDir = path.join(
      TEMP_DIR,
      `gdx_reword_worktree_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`
   );
   let didCreateWorktree = false;
   const oldShaToNewShaMap: Record<string, string> = {};
   const shaFromGitOutputRegex = /\[detached HEAD ([\da-f]+)\]/;
   let spinnerCtrl: SpinnerController | null = null;

   try {
      await $`${git$} worktree add --detach ${worktreeDir} ${headSha}`;
      didCreateWorktree = true;

      const worktreeGit: string[] = [resolveGitExecutable(git$), '-C', worktreeDir];
      const [targetTree, targetParents, targetAuthor] = await Promise.all([
         resolveCommitTree(git$, targetSha),
         resolveCommitParents(git$, targetSha),
         resolveCommitAuthor(git$, targetSha),
      ]);

      const rewrittenTarget = await createCommitFromTree({
         git$: worktreeGit,
         treeSha: targetTree,
         parents: targetParents,
         messageFile,
         author: targetAuthor,
      });

      await $`${worktreeGit} checkout --detach ${rewrittenTarget}`;

      const replayCommits = await listReplayCommits(git$, targetSha, headSha);
      spinnerCtrl =
         replayCommits.length > 50
            ? spinner({
               message: `Replaying commits... (0/${replayCommits.length})`,
            })
            : null;

      let replayCounter = 0;
      for (const commit of replayCommits) {
         const cherryPickResult = await $`${worktreeGit} cherry-pick ${commit}`;
         oldShaToNewShaMap[commit] =
            shaFromGitOutputRegex.exec(cherryPickResult.stdout)?.[1] || 'unknown';
         spinnerCtrl?.setMessage(
            `Replaying commits... (${++replayCounter}/${replayCommits.length})`
         );
      }

      spinnerCtrl?.setMessage('Repositioning HEAD...');
      const rewrittenHead = (await revParseCached(worktreeGit, 'HEAD')).trim();
      const [originalHeadTree, rewrittenHeadTree] = await Promise.all([
         resolveCommitTree(git$, headSha),
         resolveCommitTree(worktreeGit, rewrittenHead),
      ]);

      if (originalHeadTree !== rewrittenHeadTree) {
         spinnerCtrl?.stop();
         throw new Err(
            'Reword aborted because rewritten history changed the HEAD tree.',
            'REWORD_TREE_MISMATCH'
         );
      }

      const headRef = await resolveHeadRef(git$);
      await $`${git$} update-ref ${headRef} ${rewrittenHead} ${headSha}`;
   } finally {
      spinnerCtrl?.stop();
      if (didCreateWorktree) {
         await $`${git$} worktree remove --force ${worktreeDir}`.catch(noop);
      }
      await fs.rm(worktreeDir, { recursive: true, force: true }).catch(noop);
   }
   return oldShaToNewShaMap;
}

/**
 * Builds git diff arguments for summarizing a single commit.
 *
 * @param git$ - Git executable path/command array.
 * @param sha - Target commit SHA.
 * @returns Arguments to pass after `git diff`.
 */
async function buildCommitDiffArgs(git$: string | string[], sha: string): Promise<string[]> {
   const parents = await resolveCommitParents(git$, sha);
   if (parents.length === 0) return [EMPTY_TREE_SHA, sha];
   return [parents[0], sha];
}

/**
 * Rewrites a commit message from an already resolved message string.
 *
 * @param options - Rewrite inputs.
 * @returns Exit code.
 */
async function rewriteCommitMessage(options: {
   git$: string | string[];
   targetSha: string;
   headSha: string;
   isHead: boolean;
   originalMessage: string;
   updatedMessage: string;
   messageFile: string;
}): Promise<number> {
   const { git$, targetSha, headSha, isHead, originalMessage, updatedMessage, messageFile } =
      options;

   if (!updatedMessage.trim()) {
      Logger.error('Commit message is empty. Aborting reword.', 'reword');
      return 1;
   }

   if (updatedMessage.trim() === originalMessage.trim()) {
      quickPrint('Commit message unchanged. No reword needed.');
      return 0;
   }

   await fs.writeFile(messageFile, updatedMessage, 'utf8');

   const renderedDiffPromise = renderCommitMessageDiffLines(originalMessage, updatedMessage).catch(
      (error) => {
         Logger.warn(`Failed to render commit message diff: ${Err.from(error).message}`, 'reword');
         return [];
      }
   );

   const rewriteSummaryLines: string[] = [];

   if (isHead) {
      const newHead = await rewriteHeadCommit(git$, headSha, messageFile);
      rewriteSummaryLines.push(
         `Rewrote ${headSha.slice(0, 7)} (HEAD) to ${newHead.slice(0, 7)} (new HEAD)`
      );
   } else {
      const oldShaToNewShaMap = await rewriteOlderCommit(git$, targetSha, headSha, messageFile);
      const mappedShasEntries = Object.entries(oldShaToNewShaMap);
      const mappedShasLength = Object.keys(oldShaToNewShaMap).length;

      if (mappedShasLength === 1) {
         rewriteSummaryLines.push(
            `Rewrote ${headSha.slice(0, 7)} (HEAD) to ${mappedShasEntries[0][1].slice(0, 7)} (new HEAD)`
         );
      }
      else {
         rewriteSummaryLines.push(`Rewrote ${mappedShasLength} commits:`);
         for (const [oldSha, newSha] of mappedShasEntries) {
            rewriteSummaryLines.push(
               `  ${oldSha.slice(0, 7)} -> ${newSha.slice(0, 7)}${oldSha === headSha ? ' (new HEAD)' : ''}${oldSha === targetSha ? ' [target]' : ''}`
            );
         }
      }
   }

   const renderedDiffLines = await renderedDiffPromise;
   for (const line of renderedDiffLines) quickPrint(line);
   quickPrint();
   for (const line of rewriteSummaryLines) quickPrint(line);

   return 0;
}

export default async function reword(ctx: GdxContext): Promise<number> {
   const { git$, args } = ctx;

   if (!(await assertInGitWorktree(git$))) return 1;

   const messageParse = parseMessageOptions(args.slice(1));
   if (messageParse.error) {
      Logger.error(messageParse.error, 'reword');
      return 1;
   }

   const parsedArgs = parseRewordArgs(messageParse.remainingArgs, messageParse.message);
   if (!parsedArgs) {
      Logger.error(
         `Usage: ${EXECUTABLE_NAME} reword [<commit>] [auto [options] | -m <message>]`,
         'reword'
      );
      return 1;
   }

   const refArgs = new ArgsSet(['reword', parsedArgs.targetRef]);
   const { error } = await expandRelativeRef(refArgs, git$, 1);
   if (error) return 1;

   const targetRef = refArgs[1] || 'HEAD';
   const targetSha = await resolveRefShaCached(git$, targetRef, { type: 'commit' });
   if (!targetSha) {
      Logger.error(`Invalid commit reference: ${targetRef}`, 'reword');
      return 1;
   }

   const headSha = (await revParseCached(git$, 'HEAD')).trim();
   const isHead = headSha === targetSha;

   if (!isHead) {
      const isAncestor = await $`${git$} merge-base --is-ancestor ${targetSha} HEAD`
         .then(() => true)
         .catch(() => false);
      if (!isAncestor) {
         Logger.error('Target commit is not an ancestor of HEAD.', 'reword');
         return 1;
      }
   }

   const tempFile = path.join(TEMP_DIR, `gdx_reword_${Date.now()}.txt`);

   try {
      const originalMessage = (await $`${git$} log -1 --format=%B ${targetSha}`).stdout;

      let updatedMessage: string;
      if (parsedArgs.mode === 'message') {
         updatedMessage = parsedArgs.message || '';
      } else if (parsedArgs.mode === 'auto') {
         const { options: autoOptions, remainingArgs } = parseAutoArgs(parsedArgs.autoArgs);
         if (remainingArgs.length > 0) {
            Logger.error(`Unknown reword auto argument(s): ${remainingArgs.join(' ')}`, 'reword');
            return 1;
         }

         if (
            (parsedArgs.autoArgs.includes('--describe') || parsedArgs.autoArgs.includes('-d')) &&
            !autoOptions.userDescription
         ) {
            Logger.warn('Ignoring --describe/-d because no description text was provided.', 'reword');
         }

         const config = await getConfig();
         const noisyFilePatterns = config.get<string[]>('commit.noisyFiles', []);
         const resolvedNoisyPatterns = Array.isArray(noisyFilePatterns)
            ? noisyFilePatterns.filter((entry) => typeof entry === 'string')
            : [];

         const spin = spinner({
            message: 'compiling commit summary...',
         });
         const commitSummary = await buildCommitDiffSummary(git$, {
            diffArgs: await buildCommitDiffArgs(git$, targetSha),
            noisyPatterns: resolvedNoisyPatterns,
         });
         spin.stop();

         if (!commitSummary.hasChanges || commitSummary.summary.trim().length === 0) {
            quickPrint(
               `${SGR.red}No changes found in the target commit. Unable to generate a commit message.${SGR.reset}`
            );
            return 1;
         }

         const generated = await generateAutoCommitMessage(ctx, {
            diffSummary: commitSummary.summary,
            userDescription: autoOptions.userDescription,
            promptOnly: autoOptions.shouldPreview,
            logScope: 'reword',
         });

         if (!generated) return 1;

         if (autoOptions.shouldPreview) {
            quickPrint(generated.prompt);
            return 0;
         }

         if (autoOptions.shouldNoCommit) {
            if (autoOptions.shouldYes) {
               Logger.warn('Ignoring --yes because --no-commit was requested.', 'reword');
            }
            if (autoOptions.shouldCopy) {
               const copied = await copyToClipboard(generated.message);
               if (copied) quickPrint(`${SGR.cyan}(message has been copied to clipboard)${SGR.reset}`);
               else Logger.warn('(failed to copy to clipboard)', 'reword');
            }
            return 0;
         }

         if (autoOptions.shouldYes) {
            updatedMessage = generated.message;
         } else {
            await fs.writeFile(tempFile, generated.message, 'utf8');
            const editor = await resolveRewordEditor();
            quickPrint(WAITING_FOR_EDITOR_HINT, '');
            await openInEditor(tempFile, editor);
            redrawText(WAITING_FOR_EDITOR_HINT, '', { end: '', inline: true });
            updatedMessage = await fs.readFile(tempFile, 'utf8');
         }
      } else {
         await fs.writeFile(tempFile, originalMessage, 'utf8');
         const editor = await resolveRewordEditor();
         quickPrint(WAITING_FOR_EDITOR_HINT, '');
         await openInEditor(tempFile, editor);
         redrawText(WAITING_FOR_EDITOR_HINT, '', { end: '', inline: true });
         updatedMessage = await fs.readFile(tempFile, 'utf8');
      }

      return await rewriteCommitMessage({
         git$,
         targetSha,
         headSha,
         isHead,
         originalMessage,
         updatedMessage,
         messageFile: tempFile,
      });
   } catch (err) {
      Logger.error(yuString(err, { color: true }), 'reword');
      return 1;
   } finally {
      await fs.unlink(tempFile).catch(noop);
   }
}

export const help = {
   long: () => {
      return strWrap(
         litedent`
         ${SGR.bright + _2PointGradient('REWORD', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         Update a commit message without rebase, no clean working directory required, and with safety checks to prevent history corruption. Ideal for quick fixes to recent commits.

         ${SGR.bright + _2PointGradient('DESCRIPTION', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         Opens the selected commit message in your editor, then rewrites history as needed. By default, it rewords HEAD. Provide a commit SHA or a relative ref (e.g. ${SGR.cyan}~2${SGR.reset}) to target older commits. Use ${SGR.cyan}-m/--message${SGR.reset} to provide the new message non-interactively, or ${SGR.cyan}auto${SGR.reset} to regenerate it from the target commit diff using the same LLM options as ${SGR.cyan}commit auto${SGR.reset}.

         ${SGR.bright + _2PointGradient('CONFIG', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         Set ${SGR.cyan}reword.editor${SGR.reset} to override the global editor. When unset, ${SGR.cyan}defaultEditor${SGR.reset} is used.

         ${SGR.bright + _2PointGradient('SAFETY', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         Rewording rewrites commit history. Ensure you coordinate with collaborators before rewriting shared commits.
         If the commit you are rewording or later commits exist on a remote, you will need to force push after rewording. Always double-check the rewritten history before pushing.
         `,
         Math.min(100, global.terminalWidth - 4),
         {
            firstIndent: '  ',
            mode: 'softboundary',
            indent: '  ',
         }
      );
   },
   short: 'Reword a commit message (defaults to HEAD).',
   usage: () => {
      return strWrap(
         litedent`
         ${SGR.cyan}${EXECUTABLE_NAME} reword ${SGR.dim}[<commit>] [auto [--no-commit|-nc] [--copy|-cp] [--yes|-y] [--describe|-d <text>] [--preview] | -m <message>]${SGR.reset}

         Examples:
            ${SGR.cyan}${EXECUTABLE_NAME} reword${SGR.reset + SGR.dim}           # Reword the latest commit${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} reword ~2${SGR.reset + SGR.dim}        # Reword HEAD~2${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} reword deadbeef${SGR.reset + SGR.dim}  # Reword a specific commit${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} reword -m ${'"better subject"'}${SGR.reset + SGR.dim} # Reword HEAD without opening an editor${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} reword ~2 auto --yes${SGR.reset + SGR.dim} # Regenerate and apply a message without editing${SGR.reset}`,
         Math.min(100, global.terminalWidth - 4),
         {
            firstIndent: '  ',
            mode: 'softboundary',
            indent: '  ',
         }
      );
   },
} as const satisfies CommandHelpObj;

export const structure = {
   $root: {
      auto: {
         $anyOf: ['--no-commit', '--copy', '--yes', '--describe', '-d', '--preview'],
      },
      $anyOf: ['-m', '--message'],
   },
} as const satisfies CommandStructure;
