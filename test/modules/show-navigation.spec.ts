import { describe, expect, it } from 'bun:test';

import {
   buildShowArgsForCommit,
   buildShowCommitNavigationPlan,
} from '@/modules/show-navigation';
import * as fs from '@/modules/fs';
import { createTestEnv } from '@/utils/testHelper';

describe('show navigation helpers', async () => {
   it('should preserve pathspec filters when building navigation args', () => {
      const plan = buildShowCommitNavigationPlan(['aaa', '--', 'README.md']);

      expect(plan.targetRef).toBe('aaa');
      expect(plan.targetIndex).toBe(0);
      expect(plan.navigationArgs).toEqual(['HEAD', '--', 'README.md']);
      expect(buildShowArgsForCommit(['aaa', '--', 'README.md'], plan, 'bbb')).toEqual([
         'bbb',
         '--',
         'README.md',
      ]);
   });

   it('should insert an explicit HEAD target before pathspec-only show args', () => {
      const plan = buildShowCommitNavigationPlan(['--', 'README.md']);

      expect(plan.targetRef).toBe('HEAD');
      expect(plan.targetIndex).toBeNull();
      expect(plan.navigationArgs).toEqual(['HEAD', '--', 'README.md']);
      expect(buildShowArgsForCommit(['--', 'README.md'], plan, 'abc123')).toEqual([
         'abc123',
         '--',
         'README.md',
      ]);
   });

   it('should skip option values while finding the target commit', () => {
      const plan = buildShowCommitNavigationPlan([
         '--author',
         'Test User',
         'aaa',
         '--',
         'README.md',
      ]);

      expect(plan.targetRef).toBe('aaa');
      expect(plan.targetIndex).toBe(2);
      expect(plan.navigationArgs).toEqual([
         '--author',
         'Test User',
         'HEAD',
         '--',
         'README.md',
      ]);
   });

   it('should let git log seek only commits that match the original pathspec', async () => {
      const { tmpDir, $, resetRepo } = await createTestEnv({
         suitName: 'show-navigation',
         initTestHarness: true,
      });
      await resetRepo('full');

      await fs.writeFile(`${tmpDir}/README.md`, 'one\n');
      await $`git add README.md`;
      await $`git commit --no-verify -m ${'readme one'}`;
      const readmeOne = (await $`git rev-parse HEAD`).stdout.trim();

      await fs.writeFile(`${tmpDir}/other.txt`, 'other\n');
      await $`git add other.txt`;
      await $`git commit --no-verify -m ${'other change'}`;
      const otherChange = (await $`git rev-parse HEAD`).stdout.trim();

      await fs.writeFile(`${tmpDir}/README.md`, 'two\n');
      await $`git add README.md`;
      await $`git commit --no-verify -m ${'readme two'}`;
      const readmeTwo = (await $`git rev-parse HEAD`).stdout.trim();

      await fs.writeFile(`${tmpDir}/README.md`, 'three\n');
      await $`git add README.md`;
      await $`git commit --no-verify -m ${'readme three'}`;
      const readmeThree = (await $`git rev-parse HEAD`).stdout.trim();

      const plan = buildShowCommitNavigationPlan([readmeTwo, '--', 'README.md']);
      const commits = (await $`git log --format=%H ${plan.navigationArgs}`).stdout
         .split('\n')
         .filter(Boolean);
      const readmeTwoIndex = commits.indexOf(readmeTwo);

      expect(commits).not.toContain(otherChange);
      expect(commits[readmeTwoIndex - 1]).toBe(readmeThree);
      expect(commits[readmeTwoIndex + 1]).toBe(readmeOne);
   });
});
