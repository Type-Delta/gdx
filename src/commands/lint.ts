import dedent from 'dedent';
import { ncc, strWrap, toShortNum } from '@lib/Tools';
import { spellCheckDocument } from 'cspell-lib';
import { GdxContext } from '../common/types';
import { createAbortableExec } from '../utils/shell';
import { quickPrint } from '../utils/utilities';
import { getConfig } from '../common/config';
import { assertInGitWorktree } from '@/utils/git';
import { EXECUTABLE_NAME, SENSITIVE_CONTENTS_REGEXES } from '@/consts';
import { prettyFormatIssues } from '@/utils/spellcheck';

export default async function lint(ctx: GdxContext): Promise<number> {
   const exec = createAbortableExec();
   const $ = exec.$;
   const { git$ } = ctx;

   if (!(await assertInGitWorktree(git$))) return 1;

   const config = await getConfig();
   const maxFileSizeKb = config.get<number>('lint.maxFileSizeKb') || 1024;

   let upstream = '';
   try {
      const { stdout } = await $`${git$} rev-parse --abbrev-ref --symbolic-full-name @{u}`
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

   // 1. Commit Message Spelling
   try {
      const { stdout: logOutput } = await $`${git$} log --pretty=format:"%s\n%b$$\$___SEP___\$$$" ${range}`;

      // eslint-disable-next-line no-useless-escape
      const commits = logOutput.split('$$\$___SEP___\$$$')
         .filter(c => c.trim());

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
   } catch {
      // Ignore if no commits found or other error
   }

   // 2. Sensitive Content & Conflict Markers
   try {
      // Get the diff content
      const { stdout: diffOutput } = await $`${git$} diff ${range}`;
      let currentFile = '';

      const files = diffOutput.split(/^diff --git a\/.+$/m);
      for (const fileDiff of files) {
         const lines = fileDiff.split('\n').filter((l) => l.trim());
         currentFile = lines.slice(2, 4)
            .find(l => l.startsWith('+++ b/'))
            ?.split(' b/')[1]
            || 'unknown';

         // Check conflict markers
         if (
            /\n?\+?<{7}(?:[^\n]*\n)*\+?={7}(?:[^\n]*\n)*\+?>{7}/.test(diffOutput)
         ) {
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
   } catch {
      // Ignore
   }

   // 3. Abnormal File Sizes
   try {
      const { stdout: filesOutput } = await $`${git$} diff --name-only ${range}`;
      const files = filesOutput.split('\n').filter((f) => f.trim());

      for (const file of files) {
         try {
            const { stdout: sizeOutput } = await $`${git$} cat-file -s HEAD:${file}`;
            const sizeBytes = parseInt(sizeOutput.trim(), 10);
            const sizeKb = sizeBytes / 1024;

            if (sizeKb > maxFileSizeKb) {
               printLWarning(
                  'Size',
                  `File size ${toShortNum(sizeBytes)}B exceeds limit of ${maxFileSizeKb}KB`
               );
               warnings++;
            }
         } catch {
            // File might have been deleted
         }
      }
   } catch {
      // Ignore
   }

   if (errors > 0) {
      quickPrint(ncc('Red') + `\nLint failed with ${errors} errors and ${warnings} warnings.` + ncc());
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
      ncc('BgYellow') + ncc('Bright') + ncc('White') + ' LWARN ' + ncc() +
      ncc('Invert') + ` ${subject} ${ncc() + ncc('Yellow')} ${message}` + ncc()
   );
}

function printLError(subject: string, message: string) {
   message = strWrap(message, 100, {
      indent: '  ',
   });

   quickPrint(
      ncc('BgRed') + ncc('Bright') + ncc('White') + ' LERROR ' + ncc() +
      ncc('Invert') + ` ${subject} ${ncc() + ncc('Red')} ${message}` + ncc()
   );
}

export const help = {
   long: dedent(`
      Runs a set of linting checks on your outgoing commits (or the last commit if no upstream is configured).

      Checks performed:
      - Spelling: Checks for typos in commit messages using cspell.
      - Sensitive Content: Scans for API keys, tokens, and private keys.
      - Conflict Markers: Checks for leftover merge conflict markers.
      - File Size: Warns if files exceed the configured size limit (default 1MB).

      Configuration:
      You can configure the behavior in your .gdxrc.toml file or \`${EXECUTABLE_NAME} gdx-config\`:
      [lint]
      onPushBehavior = "off" | "error" | "warning"  # Default: "off"
      maxFileSizeKb = 1024                          # Default: 1024 KB
   `),
   short: 'Lint outgoing commits for format, spelling, sensitive data, and more.',
   usage: dedent(`
      ${EXECUTABLE_NAME} lint

      Examples:
        ${EXECUTABLE_NAME} lint         # Run lint checks on outgoing commits
   `),
};
