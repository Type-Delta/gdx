import { describe, expect } from 'bun:test';
import path from 'path';

import gh, { buildRepoCreatePlan } from '@/commands/gh';
import { ArgsSet } from '@/modules/arguments';
import * as fs from '@/modules/fs';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';

describe('gh repo create wrapper', async () => {
   const { tmpDir, tmpRootDir, $, it } = await createTestEnv({ suitName: 'gh-repo-create' });

   it('builds push-existing args from project metadata', async () => {
      fs.writeFileSync(
         path.join(tmpDir, 'package.json'),
         JSON.stringify({ name: 'pkg-name', description: 'Package description' })
      );

      const plan = await buildRepoCreatePlan(
         createGdxContext(tmpDir, ['gh', 'repo', 'create']),
         new ArgsSet(['repo', 'create']),
         async () => ''
      );

      expect(plan.mode).toBe('push');
      expect(plan.args).toContain('--source');
      expect(plan.args.map((arg) => path.normalize(arg))).toContain(path.normalize(tmpDir));
      expect(plan.args).toContain('pkg-name');
      expect(plan.args).toContain('--description');
      expect(plan.args).toContain('Package description');
      expect(plan.args).toContain('--remote');
      expect(plan.args).toContain('origin');
      expect(plan.args).toContain('--push');
      expect(plan.args).toContain('--private');
      expect(plan.summary).toContain('Name: pkg-name');
      expect(plan.summary).toContain('Description: Package description');
      expect(plan.summary).toContain('License: (none)');
   });

   it('asks for from-scratch values and adds README when present', async () => {
      const outsideDir = path.join(tmpRootDir, 'outside-gh-create');
      fs.mkdirSync(outsideDir, { recursive: true });
      fs.writeFileSync(path.join(outsideDir, 'README.md'), 'hello');

      const originalCwd = process.cwd();
      process.chdir(outsideDir);
      try {
         const ctx = createGdxContext(outsideDir, ['gh', 'repo', 'create']);
         const answers = ['scratch-name', 'Scratch description', 'mit'];
         const plan = await buildRepoCreatePlan(
            ctx,
            new ArgsSet(['repo', 'create']),
            async () => answers.shift() || ''
         );

         expect(plan.mode).toBe('scratch');
         expect(plan.args).toContain('scratch-name');
         expect(plan.args).toContain('--description');
         expect(plan.args).toContain('Scratch description');
         expect(plan.args).toContain('--license');
         expect(plan.args).toContain('mit');
         expect(plan.args).toContain('--add-readme');
         expect(plan.args).toContain('--clone');
         expect(plan.args).toContain('--private');
         expect(plan.args).not.toContain('--gitignore');
      } finally {
         process.chdir(originalCwd);
      }
   });

   it('asks for push-existing name and description when metadata is missing', async () => {
      fs.rmSync(path.join(tmpDir, 'package.json'), { force: true });
      const answers = ['asked-name', 'asked description'];
      const plan = await buildRepoCreatePlan(
         createGdxContext(tmpDir, ['gh', 'repo', 'create']),
         new ArgsSet(['repo', 'create']),
         async () => answers.shift() || ''
      );

      expect(plan.mode).toBe('push');
      expect(plan.args).toContain('asked-name');
      expect(plan.args).toContain('--description');
      expect(plan.args).toContain('asked description');
   });

   it('does not add a license when from-scratch license answer is blank', async () => {
      const outsideDir = path.join(tmpRootDir, 'outside-gh-create-no-license');
      fs.mkdirSync(outsideDir, { recursive: true });

      const originalCwd = process.cwd();
      process.chdir(outsideDir);
      try {
         const answers = ['scratch-no-license', 'No license description', ''];
         const plan = await buildRepoCreatePlan(
            createGdxContext(outsideDir, ['gh', 'repo', 'create']),
            new ArgsSet(['repo', 'create']),
            async () => answers.shift() || ''
         );

         expect(plan.args).toContain('scratch-no-license');
         expect(plan.args).toContain('No license description');
         expect(plan.args).not.toContain('--license');
         expect(plan.summary).toContain('License: (none)');
      } finally {
         process.chdir(originalCwd);
      }
   });

   it('builds push-existing args from pyproject metadata', async () => {
      fs.rmSync(path.join(tmpDir, 'package.json'), { force: true });
      fs.writeFileSync(
         path.join(tmpDir, 'pyproject.toml'),
         '[project]\nname = "py-name"\ndescription = "Python description"\n'
      );

      const plan = await buildRepoCreatePlan(
         createGdxContext(tmpDir, ['gh', 'repo', 'create']),
         new ArgsSet(['repo', 'create']),
         async () => ''
      );

      expect(plan.args).toContain('py-name');
      expect(plan.args).toContain('--description');
      expect(plan.args).toContain('Python description');
      expect(plan.summary.some((line) => line.startsWith('Command:'))).toBe(false);
   });

   it('shows explicit license in repo-create summary', async () => {
      fs.writeFileSync(
         path.join(tmpDir, 'package.json'),
         JSON.stringify({ name: 'licensed-pkg', description: 'Licensed package' })
      );

      const plan = await buildRepoCreatePlan(
         createGdxContext(tmpDir, ['gh', 'repo', 'create', '--license', 'mit']),
         new ArgsSet(['repo', 'create', '--license', 'mit']),
         async () => ''
      );

      expect(plan.summary).toContain('Name: licensed-pkg');
      expect(plan.summary).toContain('Description: Licensed package');
      expect(plan.summary).toContain('License: mit');
   });

   it('checks gh auth before asking repo-create questions', async () => {
      const marker = path.join(tmpRootDir, 'gh-create-marker.txt');
      const ghShim = path.join(tmpRootDir, process.platform === 'win32' ? 'gh-auth-shim.cmd' : 'gh-auth-shim');
      if (process.platform === 'win32') {
         fs.writeFileSync(
            ghShim,
            `@echo off\nif "%~1"=="auth" if "%~2"=="status" exit /b 1\necho %* > "${marker}"\nexit /b 0\n`
         );
      } else {
         fs.writeFileSync(
            ghShim,
            `#!/usr/bin/env sh\nif [ "$1 $2" = "auth status" ]; then exit 1; fi\necho "$@" > "${marker}"\n`
         );
         await $`chmod +x ${ghShim}`;
      }

      const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
      const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
      Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
      Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
      try {
         const result = await gh(createGdxContext(tmpDir, ['gh', 'repo', 'create']), ghShim);

         expect(result).toBe(1);
         expect(fs.existsSync(marker)).toBe(false);
      } finally {
         if (stdinDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
         if (stdoutDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
      }
   });

   it('passes non-wrapped gh commands through to gh executable', async () => {
      const ghShim = path.join(tmpRootDir, process.platform === 'win32' ? 'gh-shim.cmd' : 'gh-shim');
      if (process.platform === 'win32') {
         fs.writeFileSync(ghShim, '@echo off\necho %*\n');
      } else {
         fs.writeFileSync(ghShim, '#!/usr/bin/env sh\necho "$@"\n');
         await $`chmod +x ${ghShim}`;
      }

      const result = await gh(createGdxContext(tmpDir, ['gh', 'repo', 'list']), ghShim);

      expect(result).toBe(0);
   });
});
