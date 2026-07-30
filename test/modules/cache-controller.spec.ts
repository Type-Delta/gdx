import { describe, expect } from 'bun:test';
import path from 'path';

import * as fs from '@/modules/fs';
import { getCache } from '@/common/cache';
import { getWhichExecCached } from '@/modules/cache-controller';
import { createTestEnv } from '@/utils/testHelper';

describe('getWhichExecCached', async () => {
   const { tmpDir, it } = await createTestEnv({ suitName: 'cache-controller', liteMode: true });

   // Two executables that both exist for the whole suite. Existence is what the old
   // implementation checked, so a meaningful test needs the stale candidate to be present.
   const firstExe = path.join(tmpDir, 'first.exe');
   const secondExe = path.join(tmpDir, 'second.exe');
   await fs.writeFile(firstExe, '');
   await fs.writeFile(secondExe, '');

   it('reuses the cached path while the search path is unchanged', async () => {
      let resolverCalls = 0;
      const resolver = async () => {
         resolverCalls++;
         return firstExe;
      };

      expect(await getWhichExecCached('stable-probe', resolver)).toBe(firstExe);
      expect(await getWhichExecCached('stable-probe', resolver)).toBe(firstExe);
      expect(resolverCalls).toBe(1);
   });

   it('re-resolves when PATH changes instead of trusting a still-existing path', async () => {
      const originalPath = process.env.PATH;
      let resolved = firstExe;
      const resolver = async () => resolved;

      try {
         expect(await getWhichExecCached('path-probe', resolver)).toBe(firstExe);

         // firstExe still exists, so an existence-only check would keep returning it even
         // though PATH now resolves the command somewhere else.
         resolved = secondExe;
         process.env.PATH = `${originalPath};${path.join(tmpDir, 'extra-bin')}`;

         expect(await getWhichExecCached('path-probe', resolver)).toBe(secondExe);
      } finally {
         process.env.PATH = originalPath;
      }
   });

   it('discards legacy bare-string entries written before env pinning', async () => {
      const cache = await getCache();
      await cache.set('which.legacy-probe', firstExe);

      expect(await getWhichExecCached('legacy-probe', async () => secondExe)).toBe(secondExe);
   });
});
