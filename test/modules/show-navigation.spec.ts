import { describe, expect, it } from 'bun:test';

import {
   buildEnhancedShowDiffText,
   buildShowBlobArgsForCommit,
   buildShowBlobNavigationPlan,
   buildShowPreamble,
   buildShowArgsForCommit,
   buildShowCommitNavigationPlan,
   buildShowCommitNavigationActions,
   isGitShowCommitOutput,
   separateShowPreamble,
} from '@/modules/show-navigation';
import * as fs from '@/modules/fs';
import { createTestEnv } from '@/utils/testHelper';

describe('show navigation helpers', async () => {
   it('should append relative ref to the commit line and file stats under the message', () => {
      const preamble = buildShowPreamble({
         preamble: [
            'commit abc123456789',
            'Author: Test User <test@example.com>',
            'Date:   Sat May 16 12:00:00 2026 +0700',
            '',
            '    subject',
            '',
         ],
         relativeRef: 'HEAD~3',
         stat: ' README.md | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)',
      });

      expect(preamble).toEqual([
         'Commit: abc123456789 (HEAD~3)',
         'Author: Test User <test@example.com>',
         'Date:   Sat May 16 12:00:00 2026 +0700',
         '',
         '    subject',
         '',
         ' README.md | 2 +-',
         ' 1 file changed, 1 insertion(+), 1 deletion(-)',
      ]);
   });

   it('should rebuild enhanced show text with enriched preamble before the diff body', () => {
      const diffText = [
         'commit abc123456789',
         'Author: Test User <test@example.com>',
         'Date:   Sat May 16 12:00:00 2026 +0700',
         '',
         '    subject',
         '',
         'diff --git a/README.md b/README.md',
         'index 1111111..2222222 100644',
      ].join('\n');

      expect(
         buildEnhancedShowDiffText(diffText, {
            relativeRef: 'HEAD',
            stat: ' README.md | 1 +\n 1 file changed, 1 insertion(+)',
         })
      ).toBe(
         [
            'Commit: abc123456789 (HEAD)',
            'Author: Test User <test@example.com>',
            'Date:   Sat May 16 12:00:00 2026 +0700',
            '',
            '    subject',
            '',
            ' README.md | 1 +',
            ' 1 file changed, 1 insertion(+)',
            '',
            'diff --git a/README.md b/README.md',
            'index 1111111..2222222 100644',
         ].join('\n')
      );
   });

   it('should rebuild enhanced show text for commits without a diff body', () => {
      const diffText = [
         'commit abc123456789',
         'Author: Test User <test@example.com>',
         'Date:   Sat May 16 12:00:00 2026 +0700',
         '',
         '    empty commit',
      ].join('\n');

      expect(isGitShowCommitOutput(diffText)).toBeTrue();
      expect(separateShowPreamble(diffText)).toEqual({
         body: '',
         preamble: diffText.split('\n'),
      });
      expect(buildEnhancedShowDiffText(diffText, { relativeRef: 'HEAD~1' })).toBe(
         [
            'Commit: abc123456789 (HEAD~1)',
            'Author: Test User <test@example.com>',
            'Date:   Sat May 16 12:00:00 2026 +0700',
            '',
            '    empty commit',
            '',
            '',
         ].join('\n')
      );
   });

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

   it('should hide unavailable show navigation actions', () => {
      expect(
         buildShowCommitNavigationActions({
            previous: 'older',
            next: 'newer',
         }).map((action) => action.label)
      ).toEqual(['previous', 'next']);

      expect(
         buildShowCommitNavigationActions({
            previous: null,
            next: 'newer',
         }).map((action) => action.label)
      ).toEqual(['next']);

      expect(
         buildShowCommitNavigationActions({
            previous: 'older',
            next: null,
         }).map((action) => action.label)
      ).toEqual(['previous']);

      expect(
         buildShowCommitNavigationActions({
            previous: null,
            next: null,
         })
      ).toEqual([]);
   });

   it('should parse revision path blob show args for commit navigation', () => {
      const plan = buildShowBlobNavigationPlan(['--date', 'iso', 'aaa:src/index.ts']);

      expect(plan).toEqual({
         targetRef: 'aaa',
         targetIndex: 2,
         navigationArgs: ['--date', 'iso', 'HEAD', '--', 'src/index.ts'],
         path: 'src/index.ts',
      });
      expect(
         plan && buildShowBlobArgsForCommit(['--date', 'iso', 'aaa:src/index.ts'], plan, 'bbb')
      ).toEqual(['--date', 'iso', 'bbb:src/index.ts']);
   });

   it('should ignore show args that are not revision path blob targets', () => {
      expect(buildShowBlobNavigationPlan(['HEAD', '--', 'README.md'])).toBeNull();
      expect(buildShowBlobNavigationPlan(['HEAD:'])).toBeNull();
      expect(buildShowBlobNavigationPlan([':README.md'])).toBeNull();
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
