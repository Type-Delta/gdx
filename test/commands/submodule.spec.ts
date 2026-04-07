import { afterAll, describe, expect } from 'bun:test';
import path from 'path';

import * as fs from '@/modules/fs';
import { addSubmodule } from '@/modules/git';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';
import { resetCache } from '@/common/cache';
import { asUnixPath } from '@/utils/path';

describe('gdx submodule switch', async () => {
   const { tmpDir, tmpRootDir, $, buffer, it, tracker } = await createTestEnv({
      autoResetBuffer: true,
   });
   const previousGdxResult = process.env.GDX_RESULT;
   process.env.GDX_RESULT = path.join(tmpRootDir, 'gdx-result');
   const consts = await import('@/consts');
   const { default: submodule } = await import('@/commands/submodule');
   const ctx = createGdxContext(tmpDir);
   const git$ = ctx.git$;
   const gitExe = Array.isArray(git$) ? git$[0] : git$;
   afterAll(() => {
      if (previousGdxResult) {
         process.env.GDX_RESULT = previousGdxResult;
      } else {
         delete process.env.GDX_RESULT;
      }
   });

   it('should switch to another submodule from inside a submodule', async () => {
      if (!gitExe) throw new Error('Git not found');

      const submoduleRoot = path.join(tmpRootDir, 'submodule-switch');
      const otherSubmoduleRoot = path.join(tmpRootDir, 'submodule-switch-other');
      fs.mkdirSync(submoduleRoot, { recursive: true });
      fs.mkdirSync(otherSubmoduleRoot, { recursive: true });

      await $`${gitExe} -C ${submoduleRoot} init`;
      await $`${gitExe} -C ${submoduleRoot} config user.name ${'Test User'}`;
      await $`${gitExe} -C ${submoduleRoot} config user.email ${'test@example.com'}`;
      fs.writeFileSync(path.join(submoduleRoot, 'README.md'), 'submodule one');
      await $`${gitExe} -C ${submoduleRoot} add README.md`;
      await $`${gitExe} -C ${submoduleRoot} commit -m ${'init submodule one'}`;

      await $`${gitExe} -C ${otherSubmoduleRoot} init`;
      await $`${gitExe} -C ${otherSubmoduleRoot} config user.name ${'Test User'}`;
      await $`${gitExe} -C ${otherSubmoduleRoot} config user.email ${'test@example.com'}`;
      fs.writeFileSync(path.join(otherSubmoduleRoot, 'README.md'), 'submodule two');
      await $`${gitExe} -C ${otherSubmoduleRoot} add README.md`;
      await $`${gitExe} -C ${otherSubmoduleRoot} commit -m ${'init submodule two'}`;

      const submoduleUrl = asUnixPath(submoduleRoot);
      const otherSubmoduleUrl = asUnixPath(otherSubmoduleRoot);
      await addSubmodule(git$, tmpDir, submoduleUrl, 'deps/submodule-one');
      await addSubmodule(git$, tmpDir, otherSubmoduleUrl, 'deps/submodule-two');
      await $`${gitExe} -C ${tmpDir} add .gitmodules ${'deps/submodule-one'} ${'deps/submodule-two'}`;
      await $`${gitExe} -C ${tmpDir} commit -m ${'Add submodules'}`;

      resetCache();
      buffer.stdout = '';
      buffer.stderr = '';
      tracker.scheduledDirs.length = 0;

      if (!consts.GDX_RESULT_FILE) {
         const failCtx = createGdxContext(path.join(tmpDir, 'deps', 'submodule-one'), [
            'submodule',
            'switch',
            'submodule-two',
         ]);
         expect(await submodule.switch(failCtx)).toBe(1);
         expect(buffer.stderr).toContain('requires the shell integration');
         return;
      }

      const switchCtx = createGdxContext(path.join(tmpDir, 'deps', 'submodule-one'), [
         'submodule',
         'switch',
         'submodule-two',
      ]);
      expect(await submodule.switch(switchCtx)).toBe(0);

      const scheduled = tracker.scheduledDirs.map((value) => asUnixPath(value));
      expect(scheduled).toEqual([asUnixPath(path.join(tmpDir, 'deps', 'submodule-two'))]);
   });

   it('should switch to main from inside a submodule', async () => {
      if (!consts.GDX_RESULT_FILE) {
         return;
      }

      resetCache();
      buffer.stdout = '';
      buffer.stderr = '';
      tracker.scheduledDirs.length = 0;

      const ctx = createGdxContext(path.join(tmpDir, 'deps', 'submodule-two'), [
         'submodule',
         'switch',
         'main',
      ]);
      expect(await submodule.switch(ctx)).toBe(0);

      const scheduled = tracker.scheduledDirs.map((value) => asUnixPath(value));
      expect(scheduled).toEqual([asUnixPath(tmpDir)]);
   });
});
