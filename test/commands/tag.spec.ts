import { describe, expect } from 'bun:test';

import { dispatch } from '@/cli/dispatch';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';

describe('gdx tag move', async () => {
   const { tmpDir, $, buffer, it } = await createTestEnv({ suitName: 'tag-move' });

   it('moves an annotated tag to another commit while preserving metadata', async () => {
      await $`git commit --allow-empty -m ${'tag-move base 1'}`;
      await $`git commit --allow-empty -m ${'tag-move base 2'}`;

      const targetCommit = (await $`git rev-parse HEAD~1`).stdout.trim();
      await $`git tag -a my-tag -m ${'release tag body'}`;

      const oldTagObject = (await $`git rev-parse refs/tags/my-tag^{tag}`).stdout.trim();
      const oldTagPayload = (await $`git cat-file tag refs/tags/my-tag`).stdout;

      const ctx = createGdxContext(tmpDir, ['tag', 'move', 'my-tag', '~1']);
      const exitCode = await dispatch(ctx);

      expect(exitCode).toBe(0);
      expect(buffer.stdout).toContain("Moved tag 'my-tag'");

      const newTagObject = (await $`git rev-parse refs/tags/my-tag^{tag}`).stdout.trim();
      const newTagPayload = (await $`git cat-file tag refs/tags/my-tag`).stdout;
      const pointedCommit = (await $`git rev-parse my-tag^{commit}`).stdout.trim();

      const expectedPayload = oldTagPayload.replace(
         /^object\s+[0-9a-f]{40}$/m,
         `object ${targetCommit}`
      );

      expect(newTagObject).not.toBe(oldTagObject);
      expect(pointedCommit).toBe(targetCommit);
      expect(newTagPayload).toBe(expectedPayload);
   });

   it('supports alias `mv` for `move`', async () => {
      await $`git commit --allow-empty -m ${'tag-mv base 1'}`;
      await $`git commit --allow-empty -m ${'tag-mv base 2'}`;

      const targetCommit = (await $`git rev-parse HEAD~2`).stdout.trim();
      await $`git tag -a my-tag-alias -m ${'alias move tag'}`;

      const ctx = createGdxContext(tmpDir, ['tag', 'mv', 'my-tag-alias', '~2']);
      const exitCode = await dispatch(ctx);

      expect(exitCode).toBe(0);

      const pointedCommit = (await $`git rev-parse my-tag-alias^{commit}`).stdout.trim();
      expect(pointedCommit).toBe(targetCommit);
   });

   it('moves lightweight tags by updating the ref target directly', async () => {
      await $`git tag light-tag`;

      const ctx = createGdxContext(tmpDir, ['tag', 'move', 'light-tag', '~1']);
      const exitCode = await dispatch(ctx);

      expect(exitCode).toBe(0);
      const expectedCommit = (await $`git rev-parse HEAD~1`).stdout.trim();
      const pointedCommit = (await $`git rev-parse light-tag^{commit}`).stdout.trim();
      expect(pointedCommit).toBe(expectedCommit);
   });
});
