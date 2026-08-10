import litedent from 'litedent';

import { strWrap, toShortNum } from '@lib/Tools';

import { CommandHelpObj, CommandStructure, GdxContext } from '../common/types';
import { createAbortableExec, spinner } from '../modules/shell';
import { quickPrint } from '../utils/utilities';
import { getConfig } from '../common/config';
import { assertInGitWorktree, getRepoRootCached, getTrackedUpstreamRef } from '@/modules/git';
import { EXECUTABLE_NAME, SENSITIVE_CONTENTS_REGEXES, GDX_VPALETTE, SGR } from '@/consts';
import Logger from '../utils/logger';
import global from '@/global';
import { _2PointGradient } from '@/modules/graphics';

export default async function lint(ctx: GdxContext): Promise<number> {
   const exec = createAbortableExec();
   const $ = exec.$;
   const { git$ } = ctx;

   if (!(await assertInGitWorktree(git$))) return 1;

   const spinnerCtrl = spinner({
      message: 'Initializing library...',
   });
   const { spellCheckDocument, prettyFormatIssues, getBundledDictionaryNames, loadLocalWordlist } =
      await import('@/modules/spellcheck');

   const config = await getConfig();
   const maxFileSizeKb = config.get<number>('lint.maxFileSizeKb') || 1024;
   const useLocalWordlist = config.get<boolean>('lint.useLocalWordlist') ?? true;

   spinnerCtrl.options.message = 'Scanning commits...';
   const upstream = (await getTrackedUpstreamRef(git$)) || '';

   let range: string;
   if (upstream) {
      range = `${upstream}..HEAD`;
   } else {
      spinnerCtrl.stop();
      Logger.warn('No upstream configured. Checking last commit only.', 'lint');
      range = 'HEAD^..HEAD';
      spinnerCtrl.start();
   }

   let errors = 0;
   let warnings = 0;

   // Run git commands (and the project wordlist lookup) in parallel
   const [logOutput, diffOutput, filesOutput, localWordlist] = await Promise.all([
      $`${git$} log --pretty=format:"%s\n%b$$\$___SEP___\$$$" ${range}`
         .then((r) => r.stdout)
         .catch(() => ''),
      $`${git$} diff ${range}`.then((r) => r.stdout).catch(() => ''),
      $`${git$} diff --name-only ${range}`.then((r) => r.stdout).catch(() => ''),
      useLocalWordlist
         ? getRepoRootCached(git$)
              .then(loadLocalWordlist)
              .catch(() => null)
         : null,
   ]);

   // 1. Commit Message Spelling
   if (logOutput) {
      spinnerCtrl.options.message = 'Checking commit message spelling...';
      const bundledDictionaries = await getBundledDictionaryNames();
      // `sources` is diagnostic only, everything else is passed straight to cspell.
      const spellSettings = {
         words: localWordlist?.words,
         ignoreWords: localWordlist?.ignoreWords,
         flagWords: localWordlist?.flagWords,
         dictionaryDefinitions: localWordlist?.dictionaryDefinitions,
         dictionaries: [...bundledDictionaries, ...(localWordlist?.dictionaries ?? [])],
      };
      // eslint-disable-next-line no-useless-escape
      const commits = logOutput.split('$$\$___SEP___\$$$').filter((c) => c.trim());

      for (const [index, commitMsg] of commits.entries()) {
         spinnerCtrl.start(false);
         // Check spelling with cspell
         const result = await spellCheckDocument(
            { uri: 'commit-message', text: commitMsg, languageId: 'plaintext', locale: 'en' },
            {
               generateSuggestions: true,
               noConfigSearch: true,
               unknownWords: 'report-common-typos',
            },
            spellSettings
         );
         if (result.issues.length === 0) continue;

         spinnerCtrl.stop();
         warnings += result.issues.length;
         printLWarning(
            'Spelling',
            `At HEAD~${index} found ${result.issues.length} potential spelling issue(s) in commit messages.\n\n` +
               prettyFormatIssues(result, commitMsg)
         );
      }
   }

   spinnerCtrl.stop();

   // 2. Sensitive Content & Conflict Markers
   if (diffOutput) {
      const files = diffOutput.split(/^diff --git a\/.+$/m);
      for (const fileDiff of files) {
         const lines = fileDiff.split('\n').filter((l) => l.trim());
         const currentFile =
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
               `File: ${file}\nFile size ${toShortNum(sizeBytes, 2, 1024)}B exceeds limit of ${maxFileSizeKb}KiB`
            );
            warnings++;
         }
      }
   }

   if (errors > 0) {
      Logger.error(`Lint failed with ${errors} errors and ${warnings} warnings.`, 'lint');
      return 1;
   } else if (warnings > 0) {
      quickPrint(SGR.yellow + `\nLint passed with ${warnings} warnings.` + SGR.reset);
      return 0;
   } else {
      quickPrint(SGR.green + '\nNo problems found.' + SGR.reset);
      return 0;
   }
}

function printLWarning(subject: string, message: string) {
   message = strWrap(message, 100, {
      indent: '  ',
   });

   quickPrint(
      SGR.bgYellow +
         SGR.bright +
         SGR.black +
         ' LWARN ' +
         SGR.reset +
         SGR.invert +
         ` ${subject} ${SGR.reset + SGR.yellow} ${message}` +
         SGR.reset
   );
}

function printLError(subject: string, message: string) {
   message = strWrap(message, 100, {
      indent: '  ',
   });

   quickPrint(
      SGR.bgRed +
         SGR.bright +
         SGR.white +
         ' LERROR ' +
         SGR.reset +
         SGR.invert +
         ` ${subject} ${SGR.reset + SGR.red} ${message}` +
         SGR.reset
   );
}

export const help = {
   long: () => {
      return strWrap(
         litedent`
         ${SGR.bright + _2PointGradient('LINT', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         Runs a set of linting checks on your outgoing commits (or the last commit if no upstream is configured).

         ${SGR.bright + _2PointGradient('CHECKS PERFORMED', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         - Spelling: Checks for typos in commit messages using cspell. Project terms already
           listed in ${SGR.cyan}.vscode/settings.json${SGR.reset} (\`cSpell.words\`) or in a cspell config file
           (\`cspell.json\`, \`.cspell.config.yaml\`, the \`cspell\` field of \`package.json\`, ...)
           are accepted automatically.
         - Sensitive Content: Scans for API keys, tokens, and private keys.
         - Conflict Markers: Checks for leftover merge conflict markers.
         - File Size: Warns if files exceed the configured size limit (default 1MB).

         ${SGR.bright + _2PointGradient('CONFIGURATION', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         You can configure the behavior in your ~/.gdx/.gdxrc.toml file or \`${SGR.cyan}${EXECUTABLE_NAME} gdx-config${SGR.reset}\`:
         [lint]
         onPushBehavior = "off" | "error" | "warning"  # Default: "off"
         maxFileSizeKb = 1024                          # Default: 1024 KB
         useLocalWordlist = true                       # Default: true
         `,
         Math.min(100, global.terminalWidth - 4),
         {
            firstIndent: '  ',
            mode: 'softboundary',
            indent: '  ',
         }
      );
   },
   short: 'Lint outgoing commits for format, spelling, sensitive data, and more.',
   usage: () => {
      return strWrap(
         litedent`
         ${SGR.cyan}${EXECUTABLE_NAME} lint${SGR.reset}

         Examples:
            ${SGR.cyan}${EXECUTABLE_NAME} lint ${SGR.reset + SGR.dim}# Run lint checks on outgoing commits${SGR.reset}`,
         Math.min(100, global.terminalWidth - 4),
         {
            firstIndent: '  ',
            mode: 'softboundary',
            indent: '  ',
         }
      );
   },
} as const satisfies CommandHelpObj;

export const structure = {
   $root: [],
} as const satisfies CommandStructure;
