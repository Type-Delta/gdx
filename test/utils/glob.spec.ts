import { describe, expect, it } from 'bun:test';

import { buildGitignoreMatcher, buildPathGlobMatcher } from '@/utils/glob';

describe('glob matchers', () => {
   const gitignoreCases = [
      { pattern: 'README.md', input: 'README.md', expected: true },
      { pattern: 'README.md', input: 'README.txt', expected: false },
      { pattern: 'file*.ts', input: 'file.test.ts', expected: true },
      { pattern: 'file*.ts', input: 'file/src.ts', expected: false },
      { pattern: 'v?.ts', input: 'v1.ts', expected: true },
      { pattern: 'v?.ts', input: 'v10.ts', expected: false },
      { pattern: 'file(name).ts', input: 'file(name).ts', expected: true },
      { pattern: 'file(name).ts', input: 'filename.ts', expected: false },
      { pattern: 'file.ts', input: 'fileXts', expected: false },
      { pattern: '', input: 'anything', expected: false },
      { pattern: '*', input: 'nested/path.txt', expected: true },
   ];

   for (const { pattern, input, expected } of gitignoreCases) {
      it('gitignore ' + JSON.stringify(pattern) + ' vs ' + JSON.stringify(input), () => {
         expect(buildGitignoreMatcher(pattern)(input)).toBe(expected);
      });
   }

   const pathCases = [
      { pattern: 'src/*.ts', input: 'src/index.ts', expected: true },
      { pattern: 'src/*.ts', input: 'src/lib/index.ts', expected: false },
      { pattern: 'src/?.ts', input: 'src/a.ts', expected: true },
      { pattern: '**/*.ts', input: 'src/lib/index.ts', expected: true },
      { pattern: '**/*.ts', input: 'index.ts', expected: true },
      { pattern: 'src/**/index.ts', input: 'src/lib/deep/index.ts', expected: true },
      { pattern: './src/index.ts', input: 'src/index.ts', expected: true },
      { pattern: '/src/index.ts', input: './src/index.ts', expected: true },
      { pattern: 'src/file(name).ts', input: 'src/file(name).ts', expected: true },
      { pattern: 'src/file(name).ts', input: 'src/filename.ts', expected: false },
      { pattern: '', input: 'anything', expected: false },
   ];

   for (const { pattern, input, expected } of pathCases) {
      it('path ' + JSON.stringify(pattern) + ' vs ' + JSON.stringify(input), () => {
         const matcher = buildPathGlobMatcher(pattern);
         expect(matcher?.(input) ?? false).toBe(expected);
      });
   }
});
