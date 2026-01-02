import { ncc, strWrap, toShortNum } from '@lib/Tools';
import { GdxContext } from '../common/types';
import { createAbortableExec } from '../utils/shell';
import { quickPrint } from '../utils/utilities';
import { getConfig } from '../common/config';
import { assertInGitWorktree } from '@/utils/git';
import { EXECUTABLE_NAME, SENSITIVE_CONTENTS_REGEXES } from '@/consts';

import { COLOR } from '@/consts';
import { _2PointGradient } from '@/utils/graphics';

export default async function lint(ctx: GdxContext): Promise<number> {
   const exec = createAbortableExec();
   const $ = exec.$;
   const { git$ } = ctx;

   if (!(await assertInGitWorktree(git$))) return 1;

   const { spellCheckDocument, prettyFormatIssues } = await import('@/utils/spellcheck');

   const config = await getConfig();
   const maxFileSizeKb = config.get<number>('lint.maxFileSizeKb') || 1024;

   let upstream = '';
   try {
      const { stdout } = await $`${git$} rev-parse --abbrev-ref --symbolic-full-name @{u}`;
      upstream = stdout.trim();
   } catch {
      // No upstream configured
   }

   let range = '';
   if (upstream) {
      range = `${upstream}..HEAD`;
   } else {
      quickPrint(ncc('Yellow') + 'No upstream configured. Checking last commit only.' + ncc());
      range = 'HEAD^..HEAD';
   }

   let errors = 0;
   let warnings = 0;

   // Run git commands in parallel
   const [logOutput, diffOutput, filesOutput] = await Promise.all([
      $`${git$} log --pretty=format:"%s\n%b$$\$___SEP___\$$$" ${range}`
         .then((r) => r.stdout)
         .catch(() => ''),
      $`${git$} diff ${range}`.then((r) => r.stdout).catch(() => ''),
      $`${git$} diff --name-only ${range}`.then((r) => r.stdout).catch(() => ''),
   ]);

   // 1. Commit Message Spelling
   if (logOutput) {
      // eslint-disable-next-line no-useless-escape
      const commits = logOutput.split('$$\$___SEP___\$$$').filter((c) => c.trim());

      for (const [index, commitMsg] of commits.entries()) {
         // Check spelling with cspell
         const result = await spellCheckDocument(
            { uri: 'commit-message', text: commitMsg, languageId: 'plaintext', locale: 'en' },
            { generateSuggestions: true, noConfigSearch: true },
            {}
         );
         if (result.issues.length === 0) continue;

         warnings += result.issues.length;
         printLWarning(
            'Spelling',
            `At HEAD~${index} found ${result.issues.length} potential spelling issue(s) in commit messages.\n\n` +
               prettyFormatIssues(result, commitMsg)
         );
      }
   }

   // 2. Sensitive Content & Conflict Markers
   if (diffOutput) {
      let currentFile = '';

      const files = diffOutput.split(/^diff --git a\/.+$/m);
      for (const fileDiff of files) {
         const lines = fileDiff.split('\n').filter((l) => l.trim());
         currentFile =
            lines
               .slice(2, 4)
               .find((l) => l.startsWith('+++ b/'))
               ?.split(' b/')[1] || 'unknown';

         // Check conflict markers
         if (/\n?\+?<{7}(?:[^\n]*\n)*\+?={7}(?:[^\n]*\n)*\+?>{7}/.test(diffOutput)) {
            printLError(
               'Conflict Markers',
               `File: ${currentFile}\nPlease resolve merge conflict markers.`
            );
            errors++;
         }

         for (let i = 3; i < lines.length; i++) {
            const line = lines[i];
            if (line.startsWith('+')) {
               const content = line.substring(1);

               // Check sensitive patterns
               for (const regex of SENSITIVE_CONTENTS_REGEXES) {
                  if (regex.test(content)) {
                     printLError(
                        'Sensitive Content',
                        `File: ${currentFile}\nMatched Pattern: ${regex}\nContent: ${content}`
                     );
                     errors++;
                  }
               }
            }
         }
      }
   }

   // 3. Abnormal File Sizes
   if (filesOutput) {
      const files = filesOutput.split('\n').filter((f) => f.trim());
      const sizePromises = files.map(async (file) => {
         try {
            const { stdout: sizeOutput } = await $`${git$} cat-file -s HEAD:${file}`;
            const sizeBytes = parseInt(sizeOutput.trim(), 10);
            return { file, sizeBytes };
         } catch {
            return null;
         }
      });

      const sizes = await Promise.all(sizePromises);

      for (const item of sizes) {
         if (!item) continue;
         const { file, sizeBytes } = item;
         const sizeKb = sizeBytes / 1024;

         if (sizeKb > maxFileSizeKb) {
            printLWarning(
               'Size',
               `File: ${file}\nFile size ${toShortNum(sizeBytes)}B exceeds limit of ${maxFileSizeKb}KB`
            );
            warnings++;
         }
      }
   }

   if (errors > 0) {
      quickPrint(
         ncc('Red') + `\nLint failed with ${errors} errors and ${warnings} warnings.` + ncc()
      );
      return 1;
   } else if (warnings > 0) {
      quickPrint(ncc('Yellow') + `\nLint passed with ${warnings} warnings.` + ncc());
      return 0;
   } else {
      quickPrint(ncc('Green') + '\nNo problems found.' + ncc());
      return 0;
   }
}

function printLWarning(subject: string, message: string) {
   message = strWrap(message, 100, {
      indent: '  ',
   });

   quickPrint(
      ncc('BgYellow') +
         ncc('Bright') +
         ncc('White') +
         ' LWARN ' +
         ncc() +
         ncc('Invert') +
         ` ${subject} ${ncc() + ncc('Yellow')} ${message}` +
         ncc()
   );
}

function printLError(subject: string, message: string) {
   message = strWrap(message, 100, {
      indent: '  ',
   });

   quickPrint(
      ncc('BgRed') +
         ncc('Bright') +
         ncc('White') +
         ' LERROR ' +
         ncc() +
         ncc('Invert') +
         ` ${subject} ${ncc() + ncc('Red')} ${message}` +
         ncc()
   );
}

export const help = {
   long: () =>
      strWrap(
         `
${ncc('Bright') + _2PointGradient('LINT', COLOR.Zinc400, COLOR.Zinc100, 0.2)}
Runs a set of linting checks on your outgoing commits (or the last commit if no upstream is configured).

${ncc('Bright') + _2PointGradient('CHECKS PERFORMED', COLOR.Zinc400, COLOR.Zinc100, 0.2)}
- Spelling: Checks for typos in commit messages using cspell.
- Sensitive Content: Scans for API keys, tokens, and private keys.
- Conflict Markers: Checks for leftover merge conflict markers.
- File Size: Warns if files exceed the configured size limit (default 1MB).

${ncc('Bright') + _2PointGradient('CONFIGURATION', COLOR.Zinc400, COLOR.Zinc100, 0.2)}
You can configure the behavior in your .gdxrc.toml file or \`${EXECUTABLE_NAME} gdx-config\`:
[lint]
onPushBehavior = "off" | "error" | "warning"  # Default: "off"
maxFileSizeKb = 1024                          # Default: 1024 KB
`,
         100,
         {
            firstIndent: '  ',
            mode: 'softboundery',
            indent: '  ',
         }
      ),
   short: 'Lint outgoing commits for format, spelling, sensitive data, and more.',
   usage: () =>
      strWrap(
         `
${ncc('Cyan')}${EXECUTABLE_NAME} lint${ncc()}

Examples:
   ${ncc('Cyan')}${EXECUTABLE_NAME} lint ${ncc() + ncc('Dim')}# Run lint checks on outgoing commits${ncc()}`,
         100,
         {
            firstIndent: '  ',
            mode: 'softboundery',
            indent: '  ',
         }
      ),
};
