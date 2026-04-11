import { Err, ncc, strWrap, yuString } from '@lib/Tools';

import { CommandHelpObj, CommandStructure, GdxContext } from '@/common/types';
import { $ } from '@/modules/shell';
import { assertInGitWorktree, expandRelativeRef, resolveRefShaCached } from '@/modules/git';
import { EXECUTABLE_NAME, GDX_VPALETTE } from '@/consts';
import { _2PointGradient } from '@/modules/graphics';
import Logger from '@/utils/logger';
import { quickPrint } from '@/utils/utilities';
import global from '@/global';
import litedent from '@/utils/litedent';

/**
 * Resolves the object type of a ref.
 * @param git$ - Git executable command tuple/path.
 * @param ref - Ref to inspect.
 * @returns Object type (`commit`, `tag`, etc.) or null if ref is invalid.
 */
async function resolveObjectType(git$: string | string[], ref: string): Promise<string | null> {
   try {
      const { stdout } = await $`${git$} cat-file -t ${ref}`;
      return stdout.trim();
   } catch {
      return null;
   }
}

/**
 * Rewrites a raw annotated tag object payload to point at another commit.
 * @param payload - Original raw payload from `git cat-file tag`.
 * @param targetCommit - Commit SHA to retarget to.
 * @returns Retargeted raw tag payload.
 */
function retargetTagPayload(payload: string, targetCommit: string): string {
   const lines = payload.split('\n');
   if (!lines[0]?.startsWith('object ')) {
      throw new Err('Invalid annotated tag object payload.', 'INVALID_TAG_OBJECT');
   }
   lines[0] = `object ${targetCommit}`;
   return lines.join('\n');
}

/**
 * Moves an existing tag to a different commit.
 * Annotated tags are recreated from their tag object payload;
 * lightweight tags are repointed directly.
 * @param ctx - GDX command context.
 * @returns Exit code.
 */
export async function moveTag(ctx: GdxContext): Promise<number> {
   const { git$, args } = ctx;

   if (!(await assertInGitWorktree(git$))) return 1;

   if (args.length !== 4) {
      Logger.error(`Usage: ${EXECUTABLE_NAME} tag [move|mv] <tag-name> <target-ref>`, 'tag');
      return 1;
   }

   const { error } = await expandRelativeRef(args, git$, 3);
   if (error) return 1;

   const tagName = args[2];
   const targetRef = args[3];
   const tagRef = `refs/tags/${tagName}`;

   try {
      const targetCommit = await resolveRefShaCached(git$, targetRef, { type: 'commit' });
      if (!targetCommit) {
         Logger.error(`Invalid target commit reference: ${targetRef}`, 'tag');
         return 1;
      }

      const objectType = await resolveObjectType(git$, tagRef);
      if (!objectType) {
         Logger.error(`Tag '${tagName}' does not exist.`, 'tag');
         return 1;
      }

      if (objectType === 'tag') {
         const oldTagObject = await resolveRefShaCached(git$, tagRef, { type: 'tag' });
         if (!oldTagObject) {
            Logger.error(`Failed to resolve current tag object for '${tagName}'.`, 'tag');
            return 1;
         }
         const oldPayload = (await $`${git$} cat-file tag ${tagRef}`).stdout;
         const newPayload = retargetTagPayload(oldPayload, targetCommit);

         const newTagObject = (await $({ input: newPayload })`${git$} mktag`).stdout.trim();
         if (!newTagObject) {
            Logger.error(`Failed to create new tag object for '${tagName}'.`, 'tag');
            return 1;
         }

         await $`${git$} update-ref ${tagRef} ${newTagObject} ${oldTagObject}`;
      } else {
         const oldObject = await resolveRefShaCached(git$, tagRef);
         if (!oldObject) {
            Logger.error(`Failed to resolve current ref for '${tagName}'.`, 'tag');
            return 1;
         }
         await $`${git$} update-ref ${tagRef} ${targetCommit} ${oldObject}`;
      }

      quickPrint(
         ncc('Green') +
         `Moved tag '${tagName}' to ${ncc('Bright') + targetCommit.slice(0, 12) + ncc('Green')}.` +
         ncc()
      );
      return 0;
   } catch (err) {
      Logger.error(yuString(Err.from(err), { color: true }), 'tag');
      return 1;
   }
}

export default {
   move: moveTag,
};

export const help = {
   long: () => {
      const bright = ncc('Bright');
      const cyan = ncc('Cyan');
      const reset = ncc();
      return strWrap(
         litedent`
         ${bright + _2PointGradient('TAG MOVE', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
         Move a tag to another commit.

         ${bright + _2PointGradient('DESCRIPTION', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
         For annotated tags, recreates a new tag object from the existing tag object, replacing
         only the target object line, then updates ${cyan}refs/tags/<name>${reset} to the new object.
         For lightweight tags, updates ${cyan}refs/tags/<name>${reset} directly to the target commit.

         ${bright + _2PointGradient('NOTES', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
         - Supports relative refs such as ${cyan}~3${reset} via GDX ref expansion.
         - Supports both annotated and lightweight tags.
         `,
         Math.min(100, global.terminalWidth - 4),
         {
            firstIndent: '  ',
            mode: 'softboundary',
            indent: '  ',
         }
      );
   },
   short: 'Extends git tag with ability to move tags.',
   usage: () => {
      const cyan = ncc('Cyan');
      const dim = ncc('Dim');
      const reset = ncc();
      return strWrap(
         litedent`
         ${cyan}${EXECUTABLE_NAME} tag move ${dim}<tag-name> <target-ref>${reset}
         ${cyan}${EXECUTABLE_NAME} tag mv   ${dim}<tag-name> <target-ref>${reset}

         Example:
            ${cyan}${EXECUTABLE_NAME} tag mv my-tag ~3 ${reset + dim}# Move my-tag to HEAD~3${reset}`,
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
      move: {},
      mv: {},
   },
} as const satisfies CommandStructure;
