/* eslint-disable no-control-regex */
import { describe, expect, it } from 'bun:test';
import { diffChars } from 'diff';

import { strWrap, ex_length, cleanString, ncc } from '@lib/Tools';
import { range } from '@/utils/math';

const red = '\x1b[31m';
const green = '\x1b[32m';
const reset = '\x1b[0m';

const testData = [
   "",
   "\u001b[38;2;205;214;244m## Command Reference\u001b[39m",
   "",
   "\u001b[38;2;147;153;178m|\u001b[39m\u001b[38;2;205;214;244m Command           \u001b[39m\u001b[38;2;147;153;178m|\u001b[39m\u001b[38;2;205;214;244m Expansion / Function                                               \u001b[39m\u001b[38;2;147;153;178m|\u001b[39m",
   "\u001b[38;2;147;153;178m|\u001b[39m\u001b[38;2;205;214;244m \u001b[39m\u001b[38;2;147;153;178m:----------------\u001b[39m\u001b[38;2;205;214;244m \u001b[39m\u001b[38;2;147;153;178m|\u001b[39m\u001b[38;2;205;214;244m \u001b[39m\u001b[38;2;147;153;178m:-----------------------------------------------------------------\u001b[39m\u001b[38;2;205;214;244m \u001b[39m\u001b[38;2;147;153;178m|\u001b[39m",
   "\u001b[38;2;147;153;178m|\u001b[39m\u001b[38;2;205;214;244m \u001b[39m\u001b[38;2;166;227;161m`s`\u001b[39m\u001b[38;2;205;214;244m, \u001b[39m\u001b[38;2;166;227;161m`stat`\u001b[39m\u001b[38;2;205;214;244m       \u001b[39m\u001b[38;2;147;153;178m|\u001b[39m\u001b[38;2;205;214;244m \u001b[39m\u001b[38;2;166;227;161m`git status`\u001b[39m\u001b[38;2;205;214;244m (use \u001b[39m\u001b[38;2;166;227;161m`-r`\u001b[39m\u001b[38;2;205;214;244m recursively run \"status\" on all submodules) \u001b[39m\u001b[38;2;147;153;178m|\u001b[39m",
   "\u001b[38;2;147;153;178m|\u001b[39m\u001b[38;2;205;214;244m \u001b[39m\u001b[38;2;166;227;161m`lg`\u001b[39m\u001b[38;2;205;214;244m, \u001b[39m\u001b[38;2;166;227;161m`lo`\u001b[39m\u001b[38;2;205;214;244m        \u001b[39m\u001b[38;2;147;153;178m|\u001b[39m\u001b[38;2;205;214;244m \u001b[39m\u001b[38;2;166;227;161m`git log --oneline --graph --all --decorate`\u001b[39m\u001b[38;2;205;214;244m                       \u001b[39m\u001b[38;2;147;153;178m|\u001b[39m",
   "\u001b[38;2;147;153;178m|\u001b[39m\u001b[38;2;205;214;244m \u001b[39m\u001b[38;2;166;227;161m`sw`\u001b[39m\u001b[38;2;205;214;244m, \u001b[39m\u001b[38;2;166;227;161m`swit`\u001b[39m\u001b[38;2;205;214;244m      \u001b[39m\u001b[38;2;147;153;178m|\u001b[39m\u001b[38;2;205;214;244m \u001b[39m\u001b[38;2;166;227;161m`git switch`\u001b[39m\u001b[38;2;205;214;244m                                                       \u001b[39m\u001b[38;2;147;153;178m|\u001b[39m",
   "\u001b[38;2;147;153;178m|\u001b[39m\u001b[38;2;205;214;244m \u001b[39m\u001b[38;2;166;227;161m`br`\u001b[39m\u001b[38;2;205;214;244m, \u001b[39m\u001b[38;2;166;227;161m`bra`\u001b[39m\u001b[38;2;205;214;244m       \u001b[39m\u001b[38;2;147;153;178m|\u001b[39m\u001b[38;2;205;214;244m \u001b[39m\u001b[38;2;166;227;161m`git branch`\u001b[39m\u001b[38;2;205;214;244m                                                       \u001b[39m\u001b[38;2;147;153;178m|\u001b[39m",
   "\u001b[38;2;147;153;178m|\u001b[39m\u001b[38;2;205;214;244m \u001b[39m\u001b[38;2;166;227;161m`cmi`\u001b[39m\u001b[38;2;205;214;244m, \u001b[39m\u001b[38;2;166;227;161m`com`\u001b[39m\u001b[38;2;205;214;244m      \u001b[39m\u001b[38;2;147;153;178m|\u001b[39m\u001b[38;2;205;214;244m \u001b[39m\u001b[38;2;166;227;161m`git commit`\u001b[39m\u001b[38;2;205;214;244m (Try \u001b[39m\u001b[38;2;166;227;161m`gdx cmi auto`\u001b[39m\u001b[38;2;205;214;244m for AI messages!)                 \u001b[39m\u001b[38;2;147;153;178m|\u001b[39m",
   "\u001b[38;2;147;153;178m|\u001b[39m\u001b[38;2;205;214;244m \u001b[39m\u001b[38;2;166;227;161m`res`\u001b[39m\u001b[38;2;205;214;244m             \u001b[39m\u001b[38;2;147;153;178m|\u001b[39m\u001b[38;2;205;214;244m \u001b[39m\u001b[38;2;166;227;161m`git reset`\u001b[39m\u001b[38;2;205;214;244m (supports \u001b[39m\u001b[38;2;166;227;161m`res ~3`\u001b[39m\u001b[38;2;205;214;244m, \u001b[39m\u001b[38;2;166;227;161m`res -h`\u001b[39m\u001b[38;2;205;214;244m expansion)                \u001b[39m\u001b[38;2;147;153;178m|\u001b[39m",
   "\u001b[38;2;147;153;178m|\u001b[39m\u001b[38;2;205;214;244m \u001b[39m\u001b[38;2;166;227;161m`dif`\u001b[39m\u001b[38;2;205;214;244m             \u001b[39m\u001b[38;2;147;153;178m|\u001b[39m\u001b[38;2;205;214;244m \u001b[39m\u001b[38;2;166;227;161m`git diff`\u001b[39m\u001b[38;2;205;214;244m (supports \u001b[39m\u001b[38;2;166;227;161m`dif ~3`\u001b[39m\u001b[38;2;205;214;244m, \u001b[39m\u001b[38;2;166;227;161m`dif origin ~2`\u001b[39m\u001b[38;2;205;214;244m expansion)          \u001b[39m\u001b[38;2;147;153;178m|\u001b[39m",
   "\u001b[38;2;147;153;178m|\u001b[39m\u001b[38;2;205;214;244m \u001b[39m\u001b[38;2;166;227;161m`sho`\u001b[39m\u001b[38;2;205;214;244m             \u001b[39m\u001b[38;2;147;153;178m|\u001b[39m\u001b[38;2;205;214;244m \u001b[39m\u001b[38;2;166;227;161m`git show`\u001b[39m\u001b[38;2;205;214;244m (supports \u001b[39m\u001b[38;2;166;227;161m`sho ~3`\u001b[39m\u001b[38;2;205;214;244m, \u001b[39m\u001b[38;2;166;227;161m`sho origin ~2`\u001b[39m\u001b[38;2;205;214;244m expansion)          \u001b[39m\u001b[38;2;147;153;178m|\u001b[39m",
   "\u001b[38;2;147;153;178m|\u001b[39m\u001b[38;2;205;214;244m \u001b[39m\u001b[38;2;166;227;161m`sta`\u001b[39m\u001b[38;2;205;214;244m, \u001b[39m\u001b[38;2;166;227;161m`st`\u001b[39m\u001b[38;2;205;214;244m       \u001b[39m\u001b[38;2;147;153;178m|\u001b[39m\u001b[38;2;205;214;244m \u001b[39m\u001b[38;2;166;227;161m`git stash`\u001b[39m\u001b[38;2;205;214;244m                                                        \u001b[39m\u001b[38;2;147;153;178m|\u001b[39m",
   "\u001b[38;2;147;153;178m|\u001b[39m\u001b[38;2;205;214;244m \u001b[39m\u001b[38;2;166;227;161m`lint`\u001b[39m\u001b[38;2;205;214;244m            \u001b[39m\u001b[38;2;147;153;178m|\u001b[39m\u001b[38;2;205;214;244m Run pre-push checks (spelling, secrets, etc.)                      \u001b[39m\u001b[38;2;147;153;178m|\u001b[39m",
   "\u001b[38;2;147;153;178m|\u001b[39m\u001b[38;2;205;214;244m \u001b[39m\u001b[38;2;166;227;161m`gdx-config`\u001b[39m\u001b[38;2;205;214;244m      \u001b[39m\u001b[38;2;147;153;178m|\u001b[39m\u001b[38;2;205;214;244m Manage gdx configuration                                           \u001b[39m\u001b[38;2;147;153;178m|\u001b[39m",
   "\u001b[38;2;147;153;178m|\u001b[39m\u001b[38;2;205;214;244m \u001b[39m\u001b[38;2;166;227;161m`reword`\u001b[39m\u001b[38;2;205;214;244m, \u001b[39m\u001b[38;2;166;227;161m`rew`\u001b[39m\u001b[38;2;205;214;244m   \u001b[39m\u001b[38;2;147;153;178m|\u001b[39m\u001b[38;2;205;214;244m Rewrite commit messages                                            \u001b[39m\u001b[38;2;147;153;178m|\u001b[39m",
   "\u001b[38;2;147;153;178m|\u001b[39m\u001b[38;2;205;214;244m \u001b[39m\u001b[38;2;166;227;161m`parallel`\u001b[39m\u001b[38;2;205;214;244m, \u001b[39m\u001b[38;2;166;227;161m`par`\u001b[39m\u001b[38;2;205;214;244m \u001b[39m\u001b[38;2;147;153;178m|\u001b[39m\u001b[38;2;205;214;244m Manage parallel worktrees for the current branch                   \u001b[39m\u001b[38;2;147;153;178m|\u001b[39m",
   "\u001b[38;2;147;153;178m|\u001b[39m\u001b[38;2;205;214;244m \u001b[39m\u001b[38;2;166;227;161m`stats`\u001b[39m\u001b[38;2;205;214;244m           \u001b[39m\u001b[38;2;147;153;178m|\u001b[39m\u001b[38;2;205;214;244m Show contribution statistics and metrics for the current repo      \u001b[39m\u001b[38;2;147;153;178m|\u001b[39m",
   "\u001b[38;2;147;153;178m|\u001b[39m\u001b[38;2;205;214;244m \u001b[39m\u001b[38;2;166;227;161m`graph`\u001b[39m\u001b[38;2;205;214;244m           \u001b[39m\u001b[38;2;147;153;178m|\u001b[39m\u001b[38;2;205;214;244m Render a GitHub-style contribution heatmap in the terminal         \u001b[39m\u001b[38;2;147;153;178m|\u001b[39m",
   "\u001b[38;2;147;153;178m|\u001b[39m\u001b[38;2;205;214;244m \u001b[39m\u001b[38;2;166;227;161m`nocap`\u001b[39m\u001b[38;2;205;214;244m           \u001b[39m\u001b[38;2;147;153;178m|\u001b[39m\u001b[38;2;205;214;244m Roast your latest commit message with AI                           \u001b[39m\u001b[38;2;147;153;178m|\u001b[39m",
   "\u001b[38;2;147;153;178m|\u001b[39m\u001b[38;2;205;214;244m \u001b[39m\u001b[38;2;166;227;161m`clear`\u001b[39m\u001b[38;2;205;214;244m           \u001b[39m\u001b[38;2;147;153;178m|\u001b[39m\u001b[38;2;205;214;244m Wipe changes in the working directory with a backup patch          \u001b[39m\u001b[38;2;147;153;178m|\u001b[39m",
   "\u001b[38;2;147;153;178m|\u001b[39m\u001b[38;2;205;214;244m \u001b[39m\u001b[38;2;166;227;161m`cache`\u001b[39m\u001b[38;2;205;214;244m           \u001b[39m\u001b[38;2;147;153;178m|\u001b[39m\u001b[38;2;205;214;244m Manage gdx cache                                                   \u001b[39m\u001b[38;2;147;153;178m|\u001b[39m",
   "\u001b[38;2;147;153;178m_\u001b[39m\u001b[3m\u001b[38;2;243;139;168mRun \u001b[39m\u001b[23m\u001b[38;2;166;227;161m`\u001b[39m\u001b[3m\u001b[38;2;166;227;161mgdx ghelp\u001b[39m\u001b[23m\u001b[38;2;166;227;161m`\u001b[39m\u001b[3m\u001b[38;2;243;139;168m to see the full list of expansions.\u001b[39m\u001b[23m\u001b[38;2;147;153;178m_\u001b[39m",
   "\u001b[38;2;205;214;244m### Expansions & Custom Commands\u001b[39m",
   "",
   "\u001b[38;2;205;214;244m| Command           | Expansion / Function                                                                         |\u001b[39m",
   "\u001b[38;2;205;214;244m| :---------------- | :------------------------------------------------------------------------------------------- |\u001b[39m",
   "\u001b[38;2;205;214;244m| `s`, `stat`       | `git status` (use `-r` recursively run \"status\" on all submodules)                           |\u001b[39m",
   "\u001b[38;2;205;214;244m| `lg`, `lo`        | `git log --oneline --graph --all --decorate`                                                 |\u001b[39m",
   "\u001b[38;2;205;214;244m| `sw`, `swit`      | `git switch`                                                                                 |\u001b[39m",
   "\u001b[38;2;205;214;244m| `br`, `bra`       | `git branch`                                                                                 |\u001b[39m",
   "\u001b[38;2;205;214;244m| `ps`              | `git push` with option expansion `-fl`=`--force-with-lease`                                  |\u001b[39m",
   "\u001b[38;2;205;214;244m| `pu`, `pl`        | `git pull`                                                                                   |\u001b[39m",
   "\u001b[38;2;205;214;244m| `sub`             | `git submodule`                                                                              |\u001b[39m",
   "\u001b[38;2;205;214;244m| `sta`             | `git stash`                                                                                  |\u001b[39m",
   "\u001b[38;2;205;214;244m| `cmi`, `com`      | `git commit` (Try `gdx cmi auto` for AI messages!)                                           |\u001b[39m",
   "\u001b[38;2;205;214;244m| `res`             | `git reset` with option expansion `-h`=`--hard`, `-s`=`--soft` (supports `res ~3` expansion) |\u001b[39m",
   "\u001b[38;2;205;214;244m| `dif`             | `git diff` (supports `dif ~3`, `dif origin ~2` expansion)                                    |\u001b[39m",
   "\u001b[38;2;205;214;244m| `sho`             | `git show` (supports `sho ~3`, `sho origin ~2` expansion)                                    |\u001b[39m",
   "\u001b[38;2;205;214;244m| `sta`, `st`       | `git stash`                                                                                  |\u001b[39m",
   "\u001b[38;2;205;214;244m| `lint`            | Run pre-push checks (spelling, secrets, etc.)                                                |\u001b[39m",
   "\u001b[38;2;205;214;244m| `gdx-config`      | Manage gdx configuration                                                                     |\u001b[39m",
   "\u001b[38;2;205;214;244m| `reword`, `rew`   | Rewrite commit messages                                                                      |\u001b[39m",
   "\u001b[38;2;205;214;244m| `parallel`, `par` | Manage parallel worktrees for the current branch                                             |\u001b[39m",
   "\u001b[38;2;205;214;244m| `stats`           | Show contribution statistics and metrics for the current repo                                |\u001b[39m",
   "\u001b[38;2;205;214;244m| `graph`           | Render a GitHub-style contribution heatmap in the terminal                                   |\u001b[39m",
   "\u001b[38;2;205;214;244m| `nocap`           | Roast your latest commit message with AI                                                     |\u001b[39m",
   "\u001b[38;2;205;214;244m| `clear`           | Wipe changes in the working directory with a backup patch                                    |\u001b[39m",
   "\u001b[38;2;205;214;244m| `cache`           | Manage gdx cache                                                                             |\u001b[39m",
   "",
   "\u001b[38;2;205;214;244m_Run `gdx ghelp` to see the full list of expansions/commands._\u001b[39m",
   "",
   "\u001b[38;2;205;214;244m### Command Extensions\u001b[39m",
   "",
   "\u001b[38;2;205;214;244m| Command                           | Expansion / Function                                                                                 |\u001b[39m",
   "\u001b[38;2;205;214;244m| :-------------------------------- | :--------------------------------------------------------------------------------------------------- |\u001b[39m",
   "\u001b[38;2;205;214;244m| `tag mv`, `tag move`              | Move a tag to a new commit (supports ref expansion)                                                  |\u001b[39m",
   "\u001b[38;2;205;214;244m| `lg export`                       | Export git log to a markdown file with enhanced formatting                                           |\u001b[39m",
   "\u001b[38;2;205;214;244m| `commit auto`                     | Generate commit messages with AI based on staged changes (supports `--no-commit` and `--copy` flags) |\u001b[39m",
   "\u001b[38;2;205;214;244m| `stash drop`                      | Drop stashes with advanced options (e.g., `drop 2..6`)                                               |\u001b[39m",
   "\u001b[38;2;205;214;244m| `stash drop pardon`               | Restore the last dropped stash                                                                       |\u001b[39m",
   "\u001b[38;2;205;214;244m| `submodule switch`                | Jump into a submodule's directory from the parent repo (requires shell integration)                  |\u001b[39m",
   "\u001b[38;2;205;214;244m| `status --recursive`, `status -r` | Show status for the main repo and all submodules recursively                                         |\u001b[39m",
   "",
   "\u001b[38;2;205;214;244m## Development\u001b[39m",
   ""
];
const cleanedTestData = testData.map(line => cleanString(line));
const testDataWords = [...generateWordSet(cleanedTestData)];
const testDataLongestWord = testDataWords.reduce((longest, word) => word.length > longest.length ? word : longest, "");

describe('strWrap', () => {
   it('wraps at farthest soft separator before max length', () => {
      const input = 'alpha, beta, gamma';
      const wrapped = strWrap(input, 12, { mode: 'softboundary', redundancyLv: -1 });

      expect(wrapped).toBe('alpha, beta,\ngamma');
   });

   it('prefers later separators instead of early breaks', () => {
      const input = 'alpha beta gamma';
      const maxLineLength = 10;
      const wrapped = strWrap(input, maxLineLength, { mode: 'softboundary', redundancyLv: -1 });

      expect(wrapped).toBe('alpha beta\ngamma');
   });

   it('keeps ansi color codes intact when wrapping', () => {
      const input = `${red}alpha${reset} ${green}beta${reset} gamma`;
      const wrapped = strWrap(input, 8, { mode: 'softboundary', redundancyLv: 0 });

      expect(wrapped).toContain(red);
      expect(wrapped).toContain(green);
      expect(wrapped).toContain(reset);
      const stripped = wrapped.replace(/\x1b\[[0-9;]*m/g, '');
      const lines = stripped.split('\n');
      expect(lines.length).toBeGreaterThanOrEqual(2);
   });

   it('keeps hyperlinks intact across wraps', () => {
      const link = '\x1b]8;;https://example.com/docs\x07docs\x1b]8;;\x07';
      const input = `see ${link} for more info`;
      const wrapped = strWrap(input, 12, { mode: 'softboundary', redundancyLv: 0 });

      expect(wrapped).toContain('\x1b]8;;https://example.com/docs\x07');
      expect(wrapped).toContain('docs');
      expect(wrapped).toContain('\x1b]8;;\x07');
   });

   it('wraps without splitting emoji when redundancyLv=2', () => {
      const input = 'alpha 😀 beta';
      const wrapped = strWrap(input, 7, { mode: 'softboundary', redundancyLv: 2 });

      expect(wrapped).toContain('😀');
      const lines = wrapped.split('\n');
      for (const line of lines) {
         expect(ex_length(line, 2)).toBeLessThanOrEqual(7);
      }
   });

   it('keeps fullwidth characters intact', () => {
      const input = 'alpha 漢字 beta';
      const wrapped = strWrap(input, 9, { mode: 'softboundary', redundancyLv: 1 });

      expect(wrapped).toBe('alpha 漢字\nbeta');
   });

   it('applies indentation correctly (indent=number)', () => {
      const input = 'alpha beta gamma10000, foxtrot';
      const wrapped = strWrap(input, 10, { mode: 'softboundary', indent: 4, firstIndent: 2 });

      expect(wrapped, 'format first indent correctly').toStartWith('  alpha beta');
      expect(wrapped, 'format subsequent indent correctly').toEndWith(
         '\n    gamma10000,\n    foxtrot'
      );
      expect(wrapped, 'format overall content correctly').toBe(
         '  alpha beta\n    gamma10000,\n    foxtrot'
      );
   });

   it('applies indentation correctly (indent=string)', () => {
      const input = 'alpha beta gamma10000, foxtrot';
      const wrapped = strWrap(input, 10, { mode: 'softboundary', indent: '--', firstIndent: '>' });

      expect(wrapped, 'format first indent correctly').toStartWith('>alpha beta');
      expect(wrapped, 'format subsequent indent correctly').toEndWith('\n--gamma10000,\n--foxtrot');
      expect(wrapped, 'format overall content correctly').toBe(
         '>alpha beta\n--gamma10000,\n--foxtrot'
      );
   });

   it('should not break words in strict mode', () => {
      const input = 'alpha beta gamma';
      const wrapped = strWrap(input, 5, { mode: 'strict', redundancyLv: -1 });

      expect(wrapped).toBe('alpha\nbeta\ngamma');
   });

   it('should group trailing punctuation in softboundary mode', () => {
      const easy = strWrap('alpha, beta; gamma.delta', 4, {
         mode: 'softboundary',
         redundancyLv: -1,
      });
      expect(easy).toBe('alpha,\nbeta;\ngamma.\ndelta');

      const hardPositive = strWrap(
         'Jump into a submodule directory (requires shell integration).',
         60,
         { mode: 'softboundary', redundancyLv: -1 }
      );
      expect(hardPositive, 'softboundary should extent boundaries to preserve punctuation').toBe(
         'Jump into a submodule directory (requires shell integration).'
      );

      const hardNegative = strWrap(
         'Jump into a submodule directory (requires shell integration).',
         60,
         { mode: 'strict', redundancyLv: -1 }
      );
      expect(hardNegative, 'strict mode should not extend boundaries').toBe(
         'Jump into a submodule directory (requires shell integration)\n.'
      );
   });

   it('should extend boundaries for more natural wrapping in softboundary mode', () => {
      const input =
         'This is a long sentence that should wrap at natural breakpoints, even if it exceeds the max length. Here is a really long word, should wrap bf ChlamydomonasReinhardtii word.';
      const wrapped = strWrap(input, 18, { mode: 'softboundary', redundancyLv: -1 });

      expect(wrapped).toBe(
         'This is a long\nsentence that should\nwrap at natural\nbreakpoints, even if\nit exceeds the max\nlength. Here is a\nreally long word,\nshould wrap bf\nChlamydomonasReinhardtii\nword.'
      );
   });

   it('applies firstIndent only once and uses indent afterwards', () => {
      const wrapped = strWrap('alpha beta gamma delta', 10, {
         mode: 'softboundary',
         firstIndent: '>',
         indent: '--',
      });

      expect(wrapped).toBe('>alpha beta\n--gamma\n--delta');
   });

   it('preserves explicit blank lines while applying indentation', () => {
      const wrapped = strWrap('alpha beta\n\ngamma delta', 8, {
         mode: 'softboundary',
         indent: 2,
         firstIndent: 0,
      });

      expect(wrapped).toBe('alpha\n  beta\n  \n  gamma\n  delta');
   });

   it('keeps long uninterrupted words unbroken in softboundary mode', () => {
      const wrapped = strWrap('supercalifragilistic', 6, {
         mode: 'softboundary',
         redundancyLv: -1,
      });

      expect(wrapped).toBe('supercalifragilistic');
   });

   it('should trim trailing whitespace', () => {
      let wrapped = strWrap('alpha  beta\t gamma', 5, { mode: 'strict', redundancyLv: -1 });
      expect(wrapped).toBe('alpha\nbeta\ngamma');

      wrapped = strWrap('alpha beta gamma', 5, { mode: 'softboundary', redundancyLv: -1 });
      expect(wrapped).toBe('alpha\nbeta\ngamma');
   });

   it('handles real-world command style strings predictably', () => {
      const wrapped = strWrap(
         'gdx submodule foreach --recursive -- jobs=4 -- command=git status --short',
         32,
         { mode: 'softboundary', redundancyLv: -1 }
      );

      expect(wrapped).toBe(
         'gdx submodule foreach --recursive\n-- jobs=4 -- command=git status -\n-short'
      );
   });

   it('should not leave trailing newlines', () => {
      const whitespaceOnly = strWrap('alpha beta gamma', 5, {
         mode: 'softboundary',
         redundancyLv: -1,
      });
      expect(whitespaceOnly, 'no newline after last word').not.toEndWith('\n');

      const punctuation = strWrap('alpha: beta gamma.', 5, {
         mode: 'softboundary',
         redundancyLv: -1,
      });
      expect(punctuation, 'no newline after punctuation').not.toEndWith('\n');
   });

   it('should respect maxLineLength even with long words in strict mode', () => {
      const wrapped = strWrap('supercalifragilistic', 6, {
         mode: 'strict',
         redundancyLv: -1,
      });

      expect(wrapped).toBe('superc\nalifra\ngilist\nic');
   });

   it('[god\'s test] should correctly handle complex strings in strict mode', () => {
      const cleanTestStr = cleanedTestData
         .map((line) => line.replace(/\s+/g, ''))
         .join('');

      for (const testRedundancyLevel of [0, 1, 2]) {
         range(testDataLongestWord.length, 130, 3, (maxLength) => {
            const wrappedLines = [];
            for (let i = 0; i < testData.length; i++) {
               if (
                  testData[i].length < maxLength ||
                  ex_length(testData[i], testRedundancyLevel) < maxLength
               ) {
                  wrappedLines.push(testData[i]);
                  continue;
               }

               const wrapped = strWrap(testData[i], maxLength, {
                  mode: 'strict',
                  redundancyLv: testRedundancyLevel,
               });

               const lines = wrapped.split('\n');
               // NOTE: Check 1: If the input string is longer than the max line length, it should be wrapped into multiple lines.
               // If it doesn't wrap, it means the function failed to apply the maxLength constraint.
               expect(lines.length, `Expected multiple lines. (testData[${i}], redundancyLv=${testRedundancyLevel}, maxLength=${maxLength})`)
                  .toBeGreaterThanOrEqual(2);

               for (const line of lines) {
                  const lineLength = ex_length(line, testRedundancyLevel);
                  const cleanLine = cleanString(line);

                  // NOTE: Check 2: Each line should not exceed the specified maxLength when measured with ex_length considering the redundancy level.
                  expect(
                     lineLength,
                     `Line length should be <= maxLength (${maxLength}). (testData[${i}], redundancyLv=${testRedundancyLevel}, maxLength=${maxLength}, line="${cleanLine}")`
                  ).toBeLessThanOrEqual(maxLength);

                  // NOTE: Check 3: Lines should not have trailing whitespace, as that would indicate improper wrapping and formatting.
                  expect(
                     /\s$/.test(cleanLine),
                     `Line should not end with a whitespace. (testData[${i}], redundancyLv=${testRedundancyLevel}, maxLength=${maxLength}, line="${cleanLine}")`
                  ).toBe(false);

                  if (/\w{2,}/.test(cleanLine)) {
                     let foundWord = false;
                     for (const word of testDataWords) {
                        if (cleanLine.includes(word)) {
                           foundWord = true;
                           break;
                        }
                     }
                     try {
                        // NOTE: Check 4: Each line with alphabetic characters should contain at least part of a known word from the original input string,
                        // which serves as evidence that the wrapping did not break words in a way that loses their integrity.
                        // If no known words are found in a line, it may indicate that the line was broken in the middle of a word,
                        // which would be a failure of the wrapping function.
                        // This check only works if the shortest maxLength is >= the length of the longest word in the test data
                        expect(
                           foundWord,
                           `Line should contain at least part of a known word as prove that no words are broken. (testData[${i}], redundancyLv=${testRedundancyLevel}, maxLength=${maxLength})`
                        ).toBe(true);
                     } catch (error) {
                        console.error(
                           `ERROR: Line did not contain any known words, indicating a possible broken word. Line content: "${cleanLine}" (testData[${i}], redundancyLv=${testRedundancyLevel}, maxLength=${maxLength})`
                        );
                        throw error;
                     }
                  }
               }

               wrappedLines.push(...lines);
            }

            const wrappedStr = wrappedLines
               .map((line) => cleanString(line).replace(/\s+/g, ''))
               .join('');

            try {
               // NOTE: Check 5: Test that the wrapped string has the same content as the original (ignoring whitespace)
               // to ensure no characters were lost or altered during wrapping
               expect(
                  wrappedStr,
                  `Wrapped string should have same content as original (ignoring whitespace) (redundancyLv=${testRedundancyLevel}, maxLength=${maxLength})`
               ).toBe(cleanTestStr);
            } catch (error) {
               const diffObjs = diffChars(cleanTestStr, wrappedStr);
               const diffStr = diffObjs.map((part) => { // added NULL char as marker to visualize added/removed segments
                  const prefix = part.added ? ncc('Invert') + ncc('Green') + '\0' : part.removed ? ncc('Invert') + ncc('Red') + '\0' : '';
                  return prefix + part.value + (prefix ? '\0' + ncc('Reset') : '');
               })
                  .join('');
               console.log(`ERROR: Content mismatch (redundancyLv=${testRedundancyLevel}, maxLength=${maxLength}):\n${diffStr}`);
               console.log(`ERROR: Diff details:`, diffObjs);
               throw error;
            }
         });
      }
   });

   it('[god\'s test] should correctly handle complex strings in softboundary mode', () => {
      const cleanTestStr = cleanedTestData
         .map((line) => line.replace(/\s+/g, ''))
         .join('');

      for (const testRedundancyLevel of [0, 1, 2]) {
         range(testDataLongestWord.length, 130, 3, (maxLength) => {
            const wrappedLines = [];
            for (let i = 0; i < testData.length; i++) {
               if (
                  testData[i].length < maxLength ||
                  ex_length(testData[i], testRedundancyLevel) < maxLength
               ) {
                  wrappedLines.push(testData[i]);
                  continue;
               }

               const wrapped = strWrap(testData[i], maxLength, {
                  mode: 'softboundary',
                  redundancyLv: testRedundancyLevel,
               });

               const lines = wrapped.split('\n');
               for (const line of lines) {
                  const cleanLine = cleanString(line);

                  // NOTE: Check 1: Lines should not have trailing whitespace, as that would indicate improper wrapping and formatting.
                  expect(
                     /\s$/.test(line),
                     `Line should not end with a whitespace. (testData[${i}], redundancyLv=${testRedundancyLevel}, maxLength=${maxLength}, line="${cleanLine}")`
                  ).toBe(false);

                  if (/\w{2,}/.test(cleanLine)) {
                     let foundWord = false;
                     for (const word of testDataWords) {
                        if (cleanLine.includes(word)) {
                           foundWord = true;
                           break;
                        }
                     }
                     try {
                        // NOTE: Check 2: Each line should contain at least part of a known word from the original input string,
                        // which serves as evidence that the wrapping did not break words in a way that loses their integrity.
                        // If no known words are found in a line, it may indicate that the line was broken in the middle of a word,
                        // which would be a failure of the wrapping function.
                        // This check only works if the shortest maxLength is >= the length of the longest word in the test data
                        expect(
                           foundWord,
                           `Line should contain at least part of a known word as prove that no words are broken. (testData[${i}], redundancyLv=${testRedundancyLevel}, maxLength=${maxLength}, line="${cleanLine}")`
                        ).toBe(true);
                     } catch (error) {
                        console.error(
                           `ERROR: Line did not contain any known words, indicating a possible broken word. Line content: "${cleanLine}" (testData[${i}], redundancyLv=${testRedundancyLevel}, maxLength=${maxLength}, line="${cleanLine}")`
                        );
                        throw error;
                     }
                  }
               }

               wrappedLines.push(...lines);
            }

            const wrappedStr = wrappedLines
               .map((line) => cleanString(line).replace(/\s+/g, ''))
               .join('');

            try {
               // NOTE: Check 3: Test that the wrapped string has the same content as the original (ignoring whitespace)
               // to ensure no characters were lost or altered during wrapping
               expect(
                  wrappedStr,
                  `Wrapped string should have same content as original (ignoring whitespace) (redundancyLv=${testRedundancyLevel}, maxLength=${maxLength})`
               ).toBe(cleanTestStr);
            } catch (error) {
               const diffObjs = diffChars(cleanTestStr, wrappedStr);
               const diffStr = diffObjs.map((part) => { // added NULL char as marker to visualize added/removed segments
                  const prefix = part.added ? ncc('Invert') + ncc('Green') + '\0' : part.removed ? ncc('Invert') + ncc('Red') + '\0' : '';
                  return prefix + part.value + (prefix ? '\0' + ncc('Reset') : '');
               })
                  .join('');
               console.log(`ERROR: Content mismatch (redundancyLv=${testRedundancyLevel}, maxLength=${maxLength}):\n${diffStr}`);
               console.log(`ERROR: Diff details:`, diffObjs);
               throw error;
            }
         });
      }
   });
});


function generateWordSet(lines: string[]): Set<string> {
   const wordSet = new Set<string>();
   for (const line of lines) {
      const words = line.split(/\W+/)
         .filter((w): w is string => !!w && w.length > 1); // Filter out empty strings and single-character "words"
      for (const word of words) {
         wordSet.add(word);
      }
   }
   return wordSet;
}
