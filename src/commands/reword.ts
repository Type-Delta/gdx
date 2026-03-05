import path from 'path';

import { Err, ncc, strWrap, yuString } from '@lib/Tools';

import * as fs from '@/modules/fs';
import { CommandHelpObj, CommandStructure, GdxContext } from '@/common/types';
import { $, $inherit, tokenizeCommand, whichExec } from '@/modules/shell';
import { getConfig } from '@/common/config';
import { assertInGitWorktree, expandRelativeRef } from '@/modules/git';
import { escapeCmdArgs, noop } from '@/utils/utilities';
import Logger from '@/utils/logger';
import { EXECUTABLE_NAME, GDX_VPALETTE, TEMP_DIR } from '@/consts';
import { _2PointGradient } from '@/modules/graphics';
import global from '@/global';

/**
 * Resolves the CLI command used to invoke gdx again.
 * Falls back to the current runtime when no script entry is available.
 */
function resolveSelfCommand(): string[] {
   const override = process.env.GDX_SELF_COMMAND;
   if (override) {
      const tokens = tokenizeCommand(override).filter(Boolean);
      if (tokens.length > 0) return tokens;
   }

   const argv0 = process.argv[0];
   const argv1 = process.argv[1];
   const scriptExt = argv1 ? path.extname(argv1).toLowerCase() : '';

   if (argv1 && fs.existsSync(argv1) && ['.js', '.mjs', '.cjs', '.ts'].includes(scriptExt)) {
      return [argv0, argv1];
   }

   return [argv0];
}

/**
 * Resolves a commit SHA from an arbitrary ref.
 */
async function resolveCommitSha(git$: string | string[], ref: string): Promise<string | null> {
   try {
      const { stdout } = await $`${git$} rev-parse --verify ${ref}^{commit}`;
      return stdout.trim();
   } catch {
      return null;
   }
}

/**
 * Resolves the parent SHA for a commit, or null for root commits.
 */
async function resolveParentSha(git$: string | string[], sha: string): Promise<string | null> {
   try {
      const { stdout } = await $`${git$} rev-parse ${sha}^`;
      return stdout.trim();
   } catch {
      return null;
   }
}

/**
 * Ensures there are no tracked staged or unstaged changes.
 */
async function assertCleanTrackedState(git$: string | string[]): Promise<boolean> {
   const [staged, unstaged] = await Promise.all([
      $`${git$} diff --cached --name-only`.then((r) => r.stdout.trim()),
      $`${git$} diff --name-only`.then((r) => r.stdout.trim()),
   ]);

   if (staged || unstaged) {
      Logger.error(
         'Working tree has uncommitted changes. Please stash or commit them before rewording.',
         'reword'
      );
      return false;
   }

   return true;
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
 * Sequence editor for git rebase that marks the target commit as reword.
 */
export async function rewordSequenceEditor(ctx: GdxContext): Promise<number> {
   const targetSha = process.env.GDX_REWORD_TARGET_SHA?.trim();
   const targetShort = process.env.GDX_REWORD_TARGET_SHORT?.trim();
   const todoPath = ctx.args[1];

   if (!targetSha || !todoPath) {
      Logger.error('Missing target commit or rebase todo file.', 'reword');
      return 1;
   }

   try {
      const content = await fs.readFile(todoPath, 'utf8');
      const lines = content.split(/\r?\n/);
      let updated = false;

      const nextLines = lines.map((line) => {
         if (updated) return line;
         if (!line.trim() || line.trim().startsWith('#')) return line;

         const match = /^(\s*)(\w+)(\s+)([0-9a-f]+)(.*)$/i.exec(line);
         if (!match) return line;

         const sha = match[4];
         const matchesTarget =
            targetSha.startsWith(sha) ||
            (targetShort ? targetShort.startsWith(sha) : false) ||
            sha.startsWith(targetSha);

         if (!matchesTarget) return line;

         updated = true;
         return `${match[1]}reword${match[3]}${match[4]}${match[5]}`;
      });

      if (!updated) {
         Logger.error('Target commit not found in rebase todo list.', 'reword');
         return 1;
      }

      await fs.writeFile(todoPath, nextLines.join('\n'), 'utf8');
      return 0;
   } catch (err) {
      Logger.error(yuString(err, { color: true }), 'reword');
      return 1;
   }
}

/**
 * Commit message editor for git rebase that injects the new message.
 */
export async function rewordCommitEditor(ctx: GdxContext): Promise<number> {
   const messageFile = process.env.GDX_REWORD_MESSAGE_FILE?.trim();
   const targetFile = ctx.args[1];

   if (!messageFile || !targetFile) {
      Logger.error('Missing commit message file for rewording.', 'reword');
      return 1;
   }

   try {
      const content = await fs.readFile(messageFile, 'utf8');
      await fs.writeFile(targetFile, content, 'utf8');
      return 0;
   } catch (err) {
      Logger.error(yuString(err, { color: true }), 'reword');
      return 1;
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

   if (!(await assertCleanTrackedState(git$))) return 1;

   const targetRef = args[1] || 'HEAD';
   const targetSha = await resolveCommitSha(git$, targetRef);
   if (!targetSha) {
      Logger.error(`Invalid commit reference: ${targetRef}`, 'reword');
      return 1;
   }

   const headSha = (await $`${git$} rev-parse HEAD`).stdout.trim();
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
         await $inherit`${git$} commit --amend -F ${tempFile}`.catch(noop);
         return 0;
      }

      const parentSha = await resolveParentSha(git$, targetSha);
      const shortSha = (await $`${git$} rev-parse --short ${targetSha}`).stdout.trim();
      const selfCommand = resolveSelfCommand();

      const sequenceArgs = [...selfCommand, '__reword-sequence-editor'];
      const editorArgs = [...selfCommand, '__reword-editor'];
      const sequenceCommand = escapeCmdArgs(sequenceArgs).join(' ');
      const editorCommand = escapeCmdArgs(editorArgs).join(' ');

      const prevSequenceEditor = process.env.GIT_SEQUENCE_EDITOR;
      const prevEditor = process.env.GIT_EDITOR;
      const prevMessageFile = process.env.GDX_REWORD_MESSAGE_FILE;
      const prevTargetSha = process.env.GDX_REWORD_TARGET_SHA;
      const prevTargetShort = process.env.GDX_REWORD_TARGET_SHORT;

      process.env.GIT_SEQUENCE_EDITOR = sequenceCommand;
      process.env.GIT_EDITOR = editorCommand;
      process.env.GDX_REWORD_MESSAGE_FILE = tempFile;
      process.env.GDX_REWORD_TARGET_SHA = targetSha;
      process.env.GDX_REWORD_TARGET_SHORT = shortSha;

      try {
         Logger.debug(
            `Rewording commit ${shortSha} using ${escapeCmdArgs(sequenceArgs).join(' ')}`,
            'reword'
         );
         if (parentSha) {
            await $inherit`${git$} rebase -i ${parentSha}`;
         } else {
            await $inherit`${git$} rebase -i --root`;
         }
      } catch (err) {
         Logger.error('Reword failed. Resolve the rebase and continue or abort.', 'reword');
         Logger.error(yuString(err, { color: true }), 'reword');
         return 1;
      } finally {
         if (prevSequenceEditor !== undefined) process.env.GIT_SEQUENCE_EDITOR = prevSequenceEditor;
         else delete process.env.GIT_SEQUENCE_EDITOR;

         if (prevEditor !== undefined) process.env.GIT_EDITOR = prevEditor;
         else delete process.env.GIT_EDITOR;

         if (prevMessageFile !== undefined) process.env.GDX_REWORD_MESSAGE_FILE = prevMessageFile;
         else delete process.env.GDX_REWORD_MESSAGE_FILE;

         if (prevTargetSha !== undefined) process.env.GDX_REWORD_TARGET_SHA = prevTargetSha;
         else delete process.env.GDX_REWORD_TARGET_SHA;

         if (prevTargetShort !== undefined) process.env.GDX_REWORD_TARGET_SHORT = prevTargetShort;
         else delete process.env.GDX_REWORD_TARGET_SHORT;
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
         `
${bright + _2PointGradient('REWORD', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
Update a commit message without editing an interactive rebase todo list.

${bright + _2PointGradient('DESCRIPTION', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
Opens the selected commit message in your editor, then rewrites history as needed. By default, it rewords HEAD. Provide a commit SHA or a relative ref (e.g. ${cyan}~2${reset}) to target older commits.

${bright + _2PointGradient('CONFIG', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
Set ${cyan}reword.editor${reset} to override the global editor. When unset, ${cyan}defaultEditor${reset} is used.

${bright + _2PointGradient('SAFETY', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
Rewording rewrites commit history. Ensure you coordinate with collaborators before rewriting shared commits.
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
         `
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
