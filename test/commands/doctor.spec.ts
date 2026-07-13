import { describe, expect } from 'bun:test';
import path from 'node:path';

import pkg from '../../package.json';

import doctor from '@/commands/doctor';
import * as fs from '@/modules/fs';
import { createTestEnv } from '@/utils/testHelper';

describe('gdx doctor', async () => {
   const { tmpRootDir, buffer, it } = await createTestEnv({ suitName: 'doctor' });
   const originalArgv1 = process.argv[1];

   const writeInstallInfo = (version: string) => {
      const nativeDir = path.join(tmpRootDir, 'native');
      fs.mkdirSync(nativeDir, { recursive: true });
      fs.writeFileSync(
         path.join(nativeDir, 'install.json'),
         JSON.stringify({
            mode: 'runtime',
            runtime: 'bun',
            platform: process.platform,
            arch: process.arch,
            version,
            useGlobalShim: false,
            useLocalShim: false,
         })
      );
      process.argv[1] = path.join(tmpRootDir, 'gdx.cjs');
   };

   it('reports a healthy installation with passing checks', async () => {
      writeInstallInfo(pkg.version);

      try {
         const exitCode = await doctor();

         expect(exitCode).toBe(0);
         expect(buffer.stdout).toContain('Post-install integration checks:');
         expect(buffer.stdout).toContain('PASS Required artifacts');
      } finally {
         process.argv[1] = originalArgv1;
      }
   }, { timeout: 60000 });

   it('reports mismatched installation metadata', async () => {
      writeInstallInfo('0.0.0');

      try {
         const exitCode = await doctor();

         expect(exitCode).toBe(1);
         expect(buffer.stdout).toContain('FAIL Install metadata');
         expect(buffer.stdout).toContain('Mismatched version');
      } finally {
         process.argv[1] = originalArgv1;
      }
   }, { timeout: 60000 });
});