import path from 'path';

import { Err, ncc, strWrap, yuString } from '@lib/Tools';

import * as fs from '@/modules/fs';
import { CommandHelpObj, CommandStructure, GdxContext } from '@/common/types';
import { $, $inherit, tokenizeCommand, whichExec } from '@/modules/shell';
import { getConfig } from '@/common/config';
import {
   assertInGitWorktree,
   expandRelativeRef,
   resolveRefShaCached,
   revParseCached,
} from '@/modules/git';
import { noop } from '@/utils/utilities';
import Logger from '@/utils/logger';
import { EXECUTABLE_NAME, GDX_VPALETTE, TEMP_DIR } from '@/consts';
import { _2PointGradient } from '@/modules/graphics';
import global from '@/global';
import litedent from '@/utils/litedent';

/**
 * Git author metadata used when creating a rewritten commit.
 */
interface CommitAuthor {
   name: string;
   email: string;
   date: string;
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
 * Opens an editor to allow the user to edit a file.
 */
async function openEditor(filePath: string, editorCommand: string): Promise<void> {
   const tokens = tokenizeCommand(editorCommand);
   const editorName = tokens.shift();

   if (!editorName) {
      throw new Err('Editor is not configured.', 'EDITOR_NOT_CONFIGURED');
   }

   const editorPath = await whichExec(editorName);
   if (!editorPath) {
      throw new Err(`Editor "${editorName}" not found in PATH.`, 'EDITOR_NOT_FOUND');
   }

   await $inherit`${editorPath} ${tokens} ${filePath}`;
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
      return fallback.trim();
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
 * Rewrites the current HEAD commit message using commit-tree.
 */
async function rewriteHeadCommit(
   git$: string | string[],
   headSha: string,
   messageFile: string
): Promise<void> {
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
}

/**
 * Rewrites a non-HEAD commit message using commit-tree + cherry-pick in a temporary worktree.
 */
async function rewriteOlderCommit(
   git$: string | string[],
   targetSha: string,
   headSha: string,
   messageFile: string
): Promise<void> {
   await fs.mkdir(TEMP_DIR, { recursive: true });

   const worktreeDir = path.join(
      TEMP_DIR,
      `gdx_reword_worktree_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`
   );
   let didCreateWorktree = false;

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
      for (const commit of replayCommits) {
         await $inherit`${worktreeGit} cherry-pick ${commit}`;
      }

      const rewrittenHead = (await revParseCached(worktreeGit, 'HEAD')).trim();
      const [originalHeadTree, rewrittenHeadTree] = await Promise.all([
         resolveCommitTree(git$, headSha),
         resolveCommitTree(worktreeGit, rewrittenHead),
      ]);

      if (originalHeadTree !== rewrittenHeadTree) {
         throw new Err(
            'Reword aborted because rewritten history changed the HEAD tree.',
            'REWORD_TREE_MISMATCH'
         );
      }

      const headRef = await resolveHeadRef(git$);
      await $`${git$} update-ref ${headRef} ${rewrittenHead} ${headSha}`;
   } finally {
      if (didCreateWorktree) {
         await $`${git$} worktree remove --force ${worktreeDir}`.catch(noop);
      }
      await fs.rm(worktreeDir, { recursive: true, force: true }).catch(noop);
   }
}

export default async function reword(ctx: GdxContext): Promise<number> {
   const { git$, args } = ctx;

   if (!(await assertInGitWorktree(git$))) return 1;

   const { error } = await expandRelativeRef(args, git$, 1);
   if (error) return 1;

   if (args.length > 2) {
      Logger.error(`Usage: ${EXECUTABLE_NAME} reword [<commit>]`, 'reword');
      return 1;
   }

   const targetRef = args[1] || 'HEAD';
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
      await fs.writeFile(tempFile, originalMessage, 'utf8');

      const editor = await resolveRewordEditor();
      await openEditor(tempFile, editor);

      const updatedMessage = await fs.readFile(tempFile, 'utf8');
      if (!updatedMessage.trim()) {
         Logger.error('Commit message is empty. Aborting reword.', 'reword');
         return 1;
      }

      if (isHead) {
         await rewriteHeadCommit(git$, headSha, tempFile);
      } else {
         await rewriteOlderCommit(git$, targetSha, headSha, tempFile);
      }

      return 0;
   } catch (err) {
      Logger.error(yuString(err, { color: true }), 'reword');
      return 1;
   } finally {
      await fs.unlink(tempFile).catch(noop);
   }
}

export const help = {
   long: () => {
      const bright = ncc('Bright');
      const cyan = ncc('Cyan');
      const reset = ncc();
      return strWrap(
         litedent`
         ${bright + _2PointGradient('REWORD', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
         Update a commit message without rebase, no clean working directory required, and with safety checks to prevent history corruption. Ideal for quick fixes to recent commits.

         ${bright + _2PointGradient('DESCRIPTION', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
         Opens the selected commit message in your editor, then rewrites history as needed. By default, it rewords HEAD. Provide a commit SHA or a relative ref (e.g. ${cyan}~2${reset}) to target older commits.

         ${bright + _2PointGradient('CONFIG', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
         Set ${cyan}reword.editor${reset} to override the global editor. When unset, ${cyan}defaultEditor${reset} is used.

         ${bright + _2PointGradient('SAFETY', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
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
      const cyan = ncc('Cyan');
      const dim = ncc('Dim');
      const reset = ncc();
      return strWrap(
         litedent`
         ${cyan}${EXECUTABLE_NAME} reword ${dim}[<commit>]${reset}

         Examples:
            ${cyan}${EXECUTABLE_NAME} reword${reset + dim}           # Reword the latest commit${reset}
            ${cyan}${EXECUTABLE_NAME} reword ~2${reset + dim}        # Reword HEAD~2${reset}
            ${cyan}${EXECUTABLE_NAME} reword deadbeef${reset + dim}  # Reword a specific commit${reset}`,
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
   $root: [],
} as const satisfies CommandStructure;
