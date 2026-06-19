import { describe, expect, it } from 'bun:test';

import * as fs from '@/modules/fs';
import {
   buildEnhancedShowDiffText,
   buildShowBlobArgsForCommit,
   buildShowBlobNavigationPlan,
   buildShowPreamble,
   buildShowArgsForCommit,
   buildShowCommitNavigationPlan,
   buildShowCommitNavigationActions,
   findAdjacentShowCommits,
   isGitShowCommitOutput,
   separateShowPreamble,
} from '@/modules/show-navigation';
import { ArgsSet } from '@/modules/arguments';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';
import { expandShowRevisionPathRefs } from '@/modules/git';

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
            prev: 'older',
            next: 'newer',
         }).map((action) => action.label)
      ).toEqual(['prev', 'next']);

      expect(
         buildShowCommitNavigationActions({
            prev: null,
            next: 'newer',
         }).map((action) => action.label)
      ).toEqual(['next']);

      expect(
         buildShowCommitNavigationActions({
            prev: 'older',
            next: null,
         }).map((action) => action.label)
      ).toEqual(['prev']);

      expect(
         buildShowCommitNavigationActions({
            prev: null,
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
         isIndexStage: false,
      });
      expect(
         plan && buildShowBlobArgsForCommit(['--date', 'iso', 'aaa:src/index.ts'], plan, 'bbb')
      ).toEqual(['--date', 'iso', 'bbb:src/index.ts']);
   });

   it('should ignore show args that are not revision path blob targets', () => {
      expect(buildShowBlobNavigationPlan(['HEAD', '--', 'README.md'])).toBeNull();
      expect(buildShowBlobNavigationPlan(['HEAD:'])).toBeNull();
   });

   it('should parse index-stage blob show args', () => {
      expect(buildShowBlobNavigationPlan([':README.md'])).toEqual({
         targetRef: '',
         targetIndex: 0,
         navigationArgs: [],
         path: 'README.md',
         isIndexStage: true,
      });
      expect(buildShowBlobNavigationPlan([':2:src/index.ts'])).toEqual({
         targetRef: '',
         targetIndex: 0,
         navigationArgs: [],
         path: 'src/index.ts',
         isIndexStage: true,
      });
   });

   it('should skip line-log ranges while finding the target commit', () => {
      const separateValuePlan = buildShowCommitNavigationPlan(['-L', ':handler:src/index.ts', 'abc']);
      const inlineValuePlan = buildShowCommitNavigationPlan(['-L:handler:src/index.ts', 'abc']);

      expect(separateValuePlan.targetRef).toBe('abc');
      expect(separateValuePlan.targetIndex).toBe(2);
      expect(separateValuePlan.navigationArgs).toEqual(['-L', ':handler:src/index.ts', 'HEAD']);
      expect(inlineValuePlan.targetRef).toBe('abc');
      expect(inlineValuePlan.targetIndex).toBe(1);
      expect(inlineValuePlan.navigationArgs).toEqual(['-L:handler:src/index.ts', 'HEAD']);
   });

   it('should expand shorthand refs inside revision path show args', async () => {
      const args = new ArgsSet(['show', '~2:src/index.ts', 'HEAD~1:README.md']);

      const result = await expandShowRevisionPathRefs(args, 'git');

      expect(result.error).toBeUndefined();
      expect([...args]).toEqual(['show', 'HEAD~2:src/index.ts', 'HEAD~1:README.md']);
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

      const blobPlan = buildShowBlobNavigationPlan([`${readmeTwo}:README.md`]);
      const blobCommits = (await $`git log --format=%H ${blobPlan?.navigationArgs || []}`).stdout
         .split('\n')
         .filter(Boolean);
      const blobReadmeTwoIndex = blobCommits.indexOf(readmeTwo);

      expect(
         buildShowCommitNavigationActions({
            prev: blobCommits[blobReadmeTwoIndex + 1] ?? null,
            next: blobCommits[blobReadmeTwoIndex - 1] ?? null,
         }).map((action) => action.label)
      ).toEqual(['prev', 'next']);

      expect(blobPlan).not.toBeNull();
      if (!blobPlan) throw new Error('Expected blob navigation plan');

      const adjacentBlobCommits = await findAdjacentShowCommits(
         createGdxContext(tmpDir).git$,
         otherChange,
         blobPlan
      );
      expect(adjacentBlobCommits).toEqual({
         prev: readmeOne,
         next: readmeTwo,
      });
      expect(buildShowCommitNavigationActions(adjacentBlobCommits).map((action) => action.label))
         .toEqual(['prev', 'next']);
   });
});
