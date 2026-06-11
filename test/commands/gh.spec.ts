import { describe, expect } from 'bun:test';
import path from 'path';

import gh, { buildRepoCreatePlan, RepoCreateQuestion } from '@/commands/gh';
import { ArgsSet } from '@/modules/arguments';
import * as fs from '@/modules/fs';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';

/**
 * Creates a test asker that answers questions from a fixed override map,
 * falling back to the question's initial value (or null for optional ones).
 */
function makeAsk(overrides: Record<string, string | null> = {}) {
   const seenQuestions: RepoCreateQuestion[] = [];
   const ask = async (questions: RepoCreateQuestion[]) => {
      seenQuestions.push(...questions);
      return Object.fromEntries(
         questions.map((q) => [q.key, overrides[q.key] !== undefined ? overrides[q.key] : q.initial ?? null])
      );
   };
   return { ask, seenQuestions };
}

describe('gh repo create wrapper', async () => {
   const { tmpDir, tmpRootDir, $, it } = await createTestEnv({ suitName: 'gh-repo-create' });

   it('builds push-existing args from project metadata', async () => {
      fs.writeFileSync(
         path.join(tmpDir, 'package.json'),
         JSON.stringify({ name: 'pkg-name', description: 'Package description' })
      );

      const { ask, seenQuestions } = makeAsk();
      const plan = await buildRepoCreatePlan(
         createGdxContext(tmpDir, ['gh', 'repo', 'create']),
         new ArgsSet(['repo', 'create']),
         ask
      );

      expect(plan).not.toBeNull();
      expect(plan!.mode).toBe('push');
      expect(plan!.args).toContain('--source');
      expect(plan!.args.map((arg) => path.normalize(arg))).toContain(path.normalize(tmpDir));
      expect(plan!.args).toContain('pkg-name');
      expect(plan!.args).toContain('--description');
      expect(plan!.args).toContain('Package description');
      expect(plan!.args).toContain('--remote');
      expect(plan!.args).toContain('origin');
      expect(plan!.args).toContain('--push');
      expect(plan!.args).toContain('--private');
      expect(plan!.summary).toContain('Name: pkg-name');
      expect(plan!.summary).toContain('Description: Package description');
      expect(plan!.summary).toContain('License: (none)');
      // Metadata fills name/description, so only visibility should be asked
      expect(seenQuestions.map((q) => q.key)).toEqual(['visibility']);
   });

   it('asks for from-scratch values and adds README when present', async () => {
      const outsideDir = path.join(tmpRootDir, 'outside-gh-create');
      fs.mkdirSync(outsideDir, { recursive: true });
      fs.writeFileSync(path.join(outsideDir, 'README.md'), 'hello');

      const originalCwd = process.cwd();
      process.chdir(outsideDir);
      try {
         const ctx = createGdxContext(outsideDir, ['gh', 'repo', 'create']);
         const { ask, seenQuestions } = makeAsk({
            name: 'scratch-name',
            description: 'Scratch description',
            license: 'mit',
         });
         const plan = await buildRepoCreatePlan(ctx, new ArgsSet(['repo', 'create']), ask);

         expect(plan).not.toBeNull();
         expect(plan!.mode).toBe('scratch');
         expect(plan!.args).toContain('scratch-name');
         expect(plan!.args).toContain('--description');
         expect(plan!.args).toContain('Scratch description');
         expect(plan!.args).toContain('--license');
         expect(plan!.args).toContain('mit');
         expect(plan!.args).toContain('--add-readme');
         expect(plan!.args).toContain('--clone');
         expect(plan!.args).toContain('--private');
         expect(plan!.args).not.toContain('--gitignore');
         expect(seenQuestions.map((q) => q.key)).toEqual([
            'name',
            'description',
            'license',
            'visibility',
         ]);
      } finally {
         process.chdir(originalCwd);
      }
   });

   it('asks for push-existing name and description when metadata is missing', async () => {
      fs.rmSync(path.join(tmpDir, 'package.json'), { force: true });
      const { ask } = makeAsk({ name: 'asked-name', description: 'asked description' });
      const plan = await buildRepoCreatePlan(
         createGdxContext(tmpDir, ['gh', 'repo', 'create']),
         new ArgsSet(['repo', 'create']),
         ask
      );

      expect(plan).not.toBeNull();
      expect(plan!.mode).toBe('push');
      expect(plan!.args).toContain('asked-name');
      expect(plan!.args).toContain('--description');
      expect(plan!.args).toContain('asked description');
   });

   it('does not add a license when from-scratch license answer is skipped', async () => {
      const outsideDir = path.join(tmpRootDir, 'outside-gh-create-no-license');
      fs.mkdirSync(outsideDir, { recursive: true });

      const originalCwd = process.cwd();
      process.chdir(outsideDir);
      try {
         const { ask } = makeAsk({
            name: 'scratch-no-license',
            description: 'No license description',
            license: null,
         });
         const plan = await buildRepoCreatePlan(
            createGdxContext(outsideDir, ['gh', 'repo', 'create']),
            new ArgsSet(['repo', 'create']),
            ask
         );

         expect(plan).not.toBeNull();
         expect(plan!.args).toContain('scratch-no-license');
         expect(plan!.args).toContain('No license description');
         expect(plan!.args).not.toContain('--license');
         expect(plan!.summary).toContain('License: (none)');
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

      const { ask } = makeAsk();
      const plan = await buildRepoCreatePlan(
         createGdxContext(tmpDir, ['gh', 'repo', 'create']),
         new ArgsSet(['repo', 'create']),
         ask
      );

      expect(plan).not.toBeNull();
      expect(plan!.args).toContain('py-name');
      expect(plan!.args).toContain('--description');
      expect(plan!.args).toContain('Python description');
      expect(plan!.summary.some((line) => line.startsWith('Command:'))).toBe(false);
   });

   it('shows explicit license in repo-create summary', async () => {
      fs.writeFileSync(
         path.join(tmpDir, 'package.json'),
         JSON.stringify({ name: 'licensed-pkg', description: 'Licensed package' })
      );

      const { ask } = makeAsk();
      const plan = await buildRepoCreatePlan(
         createGdxContext(tmpDir, ['gh', 'repo', 'create', '--license', 'mit']),
         new ArgsSet(['repo', 'create', '--license', 'mit']),
         ask
      );

      expect(plan).not.toBeNull();
      expect(plan!.summary).toContain('Name: licensed-pkg');
      expect(plan!.summary).toContain('Description: Licensed package');
      expect(plan!.summary).toContain('License: mit');
   });

   it('applies the selected visibility answer', async () => {
      fs.writeFileSync(
         path.join(tmpDir, 'package.json'),
         JSON.stringify({ name: 'vis-pkg', description: 'Visibility package' })
      );

      const { ask, seenQuestions } = makeAsk({ visibility: 'public' });
      const plan = await buildRepoCreatePlan(
         createGdxContext(tmpDir, ['gh', 'repo', 'create']),
         new ArgsSet(['repo', 'create']),
         ask
      );

      expect(plan).not.toBeNull();
      expect(plan!.args).toContain('--public');
      expect(plan!.args).not.toContain('--private');
      expect(plan!.summary).toContain('Visibility: public');
      const visibilityQuestion = seenQuestions.find((q) => q.key === 'visibility');
      expect(visibilityQuestion?.type).toBe('choice');
      expect(visibilityQuestion?.options).toEqual(['private', 'public', 'internal']);
      expect(visibilityQuestion?.initial).toBe('private');
   });

   it('skips the visibility question when a visibility flag is given', async () => {
      fs.writeFileSync(
         path.join(tmpDir, 'package.json'),
         JSON.stringify({ name: 'vis-flag-pkg', description: 'Visibility flag package' })
      );

      const { ask, seenQuestions } = makeAsk();
      const plan = await buildRepoCreatePlan(
         createGdxContext(tmpDir, ['gh', 'repo', 'create', '--internal']),
         new ArgsSet(['repo', 'create', '--internal']),
         ask
      );

      expect(plan).not.toBeNull();
      expect(plan!.args).toContain('--internal');
      expect(plan!.args).not.toContain('--private');
      expect(seenQuestions.map((q) => q.key)).not.toContain('visibility');
   });

   it('returns null when the asker reports an aborted form', async () => {
      const plan = await buildRepoCreatePlan(
         createGdxContext(tmpDir, ['gh', 'repo', 'create']),
         new ArgsSet(['repo', 'create']),
         async () => null
      );

      expect(plan).toBeNull();
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
