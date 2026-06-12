import * as path from 'path';

import {
   maxFraction,
   ncc,
   toShortNum,
   yuString,
   strWrap,
   ex_length,
   strJustify,
   hyperlink,
   MathKit,
} from '@lib/Tools';

import { CommandHelpObj, CommandStructure, GdxContext } from '../common/types';
import { createAbortableExec, spinner } from '../modules/shell';
import { quickPrint, routeItems } from '../utils/utilities';
import graph from './graph';
import { argsSet } from '../modules/arguments';
import {
   EXECUTABLE_NAME,
   STATS_EST,
   GDX_VPALETTE,
   KNOWN_GIT_FAULT_FILE_HEURISTICS,
   SGR,
} from '../consts';
import global from '@/global';
import { _2PointGradient } from '../modules/graphics';
import Logger from '../utils/logger';
import {
   getRepoRootCached,
   getGitConfigCached,
   getGitBranchesCached,
   assertInGitWorktree,
   getNormalizedRemoteUrl,
   getSubmodules,
} from '@/modules/git';
import {
   DEFAULT_LANGUAGE_COLOR,
   getLanguageCatalog,
   inferLanguageFromPath,
   type LanguageCatalog,
} from '@/modules/languages';
import litedent from '@/utils/litedent';
import { toShortBytes } from '@/utils/data';

interface ParsedNumStat {
   totalAdded: number;
   totalRemoved: number;
   totalRecords: number;
   netFiles: Array<{ filePath: string; netLines: number }>;
   activityFiles: Array<{ filePath: string; activityLines: number }>;
}

interface LanguageUsageBar {
   bar: string;
   legend: string;
}

interface TopContributor {
   email: string;
   username: string;
   contributionPct: string;
}

interface RemoteLinkInfo {
   repoUrl: string | null;
   host: string | null;
   provider: 'github' | 'gitlab' | 'gitea' | null;
}

interface GarbageObjectStats {
   total: number;
   commit: number;
   objectIds: Set<string>;
}

interface ObjectInventoryStats {
   totalObjects: number;
   totalBytes: number;
   garbageObjects: number;
   garbageBytes: number;
}

type LanguageMetricMode = 'auto' | 'net' | 'activity';
type ResolvedLanguageMetricMode = Exclude<LanguageMetricMode, 'auto'>;

export default async function stats(ctx: GdxContext): Promise<number> {
   const exec = createAbortableExec();
   const $ = exec.$;

   const { args, git$ } = ctx;

   if (!(await assertInGitWorktree(git$))) return 1;

   const isAllScope = args.hasOption('--all') || args.hasOption('-a');
   args.popOption('--all');
   args.popOption('-a');

   const hasLanguageMetric = args.hasOption('--lang-metric');
   const languageMetricRaw = args.popValue('--lang-metric');
   const languageMetricMode = parseLanguageMetricMode(languageMetricRaw, hasLanguageMetric);
   if (!languageMetricMode) {
      Logger.error(
         'Invalid --lang-metric value. Use one of: auto, net, activity (for example: --lang-metric auto).',
         'stats'
      );
      return 1;
   }
   const resolvedLanguageMetricMode = resolveLanguageMetricMode(languageMetricMode, isAllScope);

   let email = '';
   let username = 'Your';
   let scopeLabel: string;

   if (!isAllScope) {
      try {
         const emailArg = args.popValue('--author');
         if (emailArg) {
            email = emailArg.trim().replace(/^["']|["']$/g, '');
         } else {
            email = await getGitConfigCached(git$, 'user.email');
            email = email ? email.trim().replace(/^["']|["']$/g, '') : email;
         }
      } catch (err) {
         exec.abort();
         Logger.error('Failed to read git config user.email.', 'stats');
         Logger.error(yuString(err, { color: true }), 'stats');
         return 1;
      }

      if (!email) {
         Logger.error('No user.email configured in git.', 'stats');
         return 1;
      }

      scopeLabel = email;
   } else {
      username = 'Project-wide';
      scopeLabel = 'all authors';
   }

   const spinnerCtrl = spinner({
      message: isAllScope ? 'Gathering project-wide stats...' : `Gathering stats for ${email}...`,
   });

   try {
      const projectTotalCmiPromise = $`${git$} rev-list --all --count`;
      const garbageObjPromise = $`${git$} fsck --unreachable --no-reflogs --no-progress --full`;
      const objectInventoryPromise = isAllScope
         ? $`${git$} cat-file --batch-all-objects --batch-check=%(objectname):%(objectsize)`
         : Promise.resolve({ stdout: '' });
      const projectLineStatsPromise = $`${git$} log --all --pretty=tformat: --numstat`;
      const firstCommitFormat = `%ar ${SGR.reset + SGR.dim}[at %h] (on %ad)` + SGR.reset;
      const lastCommitFormat = `%ar ${SGR.reset + SGR.dim}[at %h] (on %ad)` + SGR.reset;
      const topContributorRawPromise = isAllScope
         ? $`${git$} log --all --format=%aN%x09%ae --numstat`
         : Promise.resolve({ stdout: '' });
      const scopedUsernamePromise = isAllScope
         ? Promise.resolve({ stdout: '' })
         : $`${git$} log --all --author=${email} -1 --format=%aN`;

      const repoRoot = (await getRepoRootCached(git$)).trim();
      const [
         scopedTotalCmiRes,
         projectTotalCmiRes,
         garbageObjRes,
         todayCommitsRes,
         scopedLogStatsRes,
         projectLineStatsRes,
         topContributorRawRes,
         scopedUsernameRes,
         branches,
         firstCommitShasRes,
         lastCommitTimeRes,
         normalizedRemoteUrl,
         submodules,
         objectInventoryRes,
      ] = await Promise.all([
         isAllScope ? projectTotalCmiPromise : $`${git$} rev-list --all --count --author=${email}`,
         projectTotalCmiPromise,
         garbageObjPromise,
         isAllScope
            ? $`${git$} log --all --since=midnight --pretty=tformat:%h`
            : $`${git$} log --all --author=${email} --since=midnight --pretty=tformat:%h`,
         isAllScope
            ? Promise.resolve({ stdout: '' })
            : $`${git$} log --all --author=${email} --pretty=tformat: --numstat`,
         projectLineStatsPromise,
         topContributorRawPromise,
         scopedUsernamePromise,
         getGitBranchesCached(git$),
         isAllScope
            ? $`${git$} rev-list --all --reverse`
            : $`${git$} rev-list --all --author=${email} --reverse`,
         isAllScope
            ? $`${git$} log --all -1 --format=${lastCommitFormat}`
            : $`${git$} log --all --author=${email} -1 --format=${lastCommitFormat}`,
         getNormalizedRemoteUrl(git$),
         getSubmodules(git$, repoRoot),
         objectInventoryPromise,
      ]);

      let languageCatalog: LanguageCatalog | null = null;
      try {
         languageCatalog = await getLanguageCatalog({
            spinner: spinnerCtrl,
         });
      } catch {
         languageCatalog = null;
      }

      const projectName = repoRoot.split(/[\\/]/).pop() || repoRoot;
      const scopedUsername = scopedUsernameRes.stdout.trim();
      if (!isAllScope && scopedUsername) username = `${scopedUsername}'s`;
      const scopedTotalCmi = parseInt(scopedTotalCmiRes.stdout.trim());
      const projectTotalCmi = parseInt(projectTotalCmiRes.stdout.trim());
      const garbageObjCounts = countGarbageObjects(garbageObjRes.stdout, garbageObjRes.stderr);
      const objectInventoryStats = isAllScope
         ? summarizeObjectInventory(objectInventoryRes.stdout, garbageObjCounts.objectIds)
         : null;
      const todayCommits = todayCommitsRes.stdout.trim()
         ? todayCommitsRes.stdout.trim().split('\n').length
         : 0;

      spinnerCtrl.setMessage('Detecting repository details...');
      const submoduleCount = submodules.length;
      const projectSuffix =
         submoduleCount > 0 ? SGR.dim + SGR.white + ` (${submoduleCount} submodules)` : '';

      const remoteLinkInfo = buildRemoteLinkInfo(normalizedRemoteUrl);
      const linkedProjectName = remoteLinkInfo.repoUrl
         ? `${hyperlink(projectName, remoteLinkInfo.repoUrl, false)}${projectSuffix}`
         : `${projectName}${projectSuffix}`;

      const statParseStart = performance.now();
      const projectNumStat = parseNumStat(projectLineStatsRes.stdout);
      const scopedNumStat = isAllScope ? projectNumStat : parseNumStat(scopedLogStatsRes.stdout);

      const totalAdded = scopedNumStat.totalAdded;
      const totalRemoved = scopedNumStat.totalRemoved;

      const addedSize = toShortBytes(totalAdded * STATS_EST.AVG_CHARS_PER_LINE, 2);
      const removedSize = toShortBytes(totalRemoved * STATS_EST.AVG_CHARS_PER_LINE, 2);

      const addedFuncs = toShortNum(
         totalAdded / STATS_EST.AVG_LINES_PER_FUNCTION,
         1,
         1e3,
         false,
         0
      );
      const removedFuncs = toShortNum(
         totalRemoved / STATS_EST.AVG_LINES_PER_FUNCTION,
         1,
         1e3,
         false,
         0
      );
      const addedFiles = toShortNum(totalAdded / STATS_EST.AVG_LINES_PER_FILE, 1, 1e3, false, 0);
      const removedFiles = toShortNum(
         totalRemoved / STATS_EST.AVG_LINES_PER_FILE,
         1,
         1e3,
         false,
         0
      );

      const projAdded = projectNumStat.totalAdded;
      const projRemoved = projectNumStat.totalRemoved;
      const totalChanged = totalAdded + totalRemoved;
      const projChanged = projAdded + projRemoved;
      const scopedContributionPct =
         projChanged > 0 ? maxFraction((totalChanged / projChanged) * 100, 2, true) : '0.00';

      const topContributor = isAllScope
         ? parseTopContributor(topContributorRawRes.stdout, projChanged)
         : null;
      const contributionPct = isAllScope
         ? topContributor
            ? topContributor.contributionPct
            : '0.00'
         : scopedContributionPct;

      const linkedTopContributor = topContributor
         ? formatUsernameWithProfileLink(topContributor.username, remoteLinkInfo)
         : 'N/A';
      const usernameWithLink = !isAllScope
         ? formatUsernameWithProfileLink(username, remoteLinkInfo)
         : username;

      const parseDuration = toShortNum((performance.now() - statParseStart) / 1e3, 2) + 's';

      let maxCommits = 0;
      let topBranch = 'N/A';

      spinnerCtrl.setMessage('Analyzing branch activity...');
      const branchCounts = await Promise.all(
         branches.map(async (branch) => {
            const { stdout } = isAllScope
               ? await $`${git$} rev-list --count refs/heads/${branch}`
               : await $`${git$} rev-list --count --author=${email} refs/heads/${branch}`;
            return { branch, count: parseInt(stdout.trim(), 10) };
         })
      );

      for (const { branch, count } of branchCounts) {
         if (count > maxCommits) {
            maxCommits = count;
            topBranch = branch;
         }
      }

      spinnerCtrl.setMessage('Resolving commit timestamps...');
      const firstCommitSha = firstCommitShasRes.stdout
         .split('\n')
         .map((line) => line.trim())
         .find((line) => line.length > 0);
      let firstCommitTime = 'Never';
      if (firstCommitSha) {
         const firstCommitTimeRes =
            await $`${git$} show -s --format=${firstCommitFormat} ${firstCommitSha}`;
         firstCommitTime = firstCommitTimeRes.stdout.trim() || 'Never';
      }
      const lastCommitTime = lastCommitTimeRes.stdout.trim() || 'Never';
      const numStatSize =
         Buffer.byteLength(projectLineStatsRes.stdout) +
         (isAllScope ? 0 : Buffer.byteLength(scopedLogStatsRes.stdout));
      const recordsParsed =
         projectNumStat.totalRecords + (isAllScope ? 0 : scopedNumStat.totalRecords);
      const orphanColor = garbageObjCounts.commit > 0 ? SGR.red : SGR.white + SGR.dim;
      const orphanLabel = `${garbageObjCounts.commit} ${SGR.white + SGR.dim}orphan${garbageObjCounts.commit === 1 ? '' : 's'}`;
      const totalCommitsSuffix = isAllScope
         ? ` / ${orphanColor}${orphanLabel}${SGR.reset}`
         : ` / ${SGR.yellow}${formatInteger(projectTotalCmi)}${SGR.reset + SGR.dim} all${SGR.reset} / ${orphanColor}${orphanLabel}${SGR.reset}`;
      const contributionLine = isAllScope
         ? `  Most Active User:    ${SGR.cyan}${linkedTopContributor}${SGR.reset} (${SGR.magenta}${contributionPct}%${SGR.reset} of all lines changed in the project)`
         : `  Contributions:       ${SGR.magenta}${contributionPct}%${SGR.reset} of all lines changed in the project`;
      const header = [
         `${SGR.dim + SGR.italic}Showing stats for ${scopeLabel} in ${projectName}${SGR.reset}`,
         `${SGR.dim}Parsed ${toShortBytes(numStatSize)} of ${toShortNum(recordsParsed, 1, 1e3, true)} numstat records in ${parseDuration}${SGR.reset}`,
      ];
      const useInlineHeader = ex_length(header[0] + header[1]) + 7 < global.terminalWidth;
      const headerText = useInlineHeader
         ? '  ' + strJustify(header, global.terminalWidth - 4, { align: 'spacebetween' })
         : header.map((line) => '  ' + line).join('\n');
      const linesAddedHint =
         global.terminalWidth > 100
            ? `(roughly ${addedSize}, ${addedFuncs} functions or ${addedFiles} source files)`
            : `(${addedSize}, ${addedFuncs} fns or ${addedFiles} files)`;
      const linesRemovedHint =
         global.terminalWidth > 100
            ? `(roughly ${removedSize}, ${removedFuncs} functions or ${removedFiles} source files)`
            : `(${removedSize}, ${removedFuncs} fns or ${removedFiles} files)`;
      const objectInventoryLine =
         isAllScope && objectInventoryStats
            ? `  Object Inventory:    ${SGR.cyan}${formatInteger(objectInventoryStats.totalObjects)}${SGR.reset} total ${SGR.dim}(${toShortBytes(objectInventoryStats.totalBytes)})${SGR.reset} / ${SGR.yellow}${formatInteger(objectInventoryStats.garbageObjects)}${SGR.reset} garbage ${SGR.dim}(${toShortBytes(objectInventoryStats.garbageBytes)})${SGR.reset}`
            : '';
      const objectStatsBlock = objectInventoryLine ? `\n${objectInventoryLine}` : '';

      spinnerCtrl.stop();
      quickPrint(`${headerText}

  ─── ${usernameWithLink} Git Stats ───
  Project:             ${SGR.cyan}${linkedProjectName}${SGR.reset}
  Total Commits:       ${SGR.green}${formatInteger(scopedTotalCmi)}${SGR.reset} (today: ${todayCommits})${totalCommitsSuffix}${objectStatsBlock}
  Total Lines Added:   ${SGR.green}+ ${formatInteger(totalAdded)} lines ${SGR.reset}${SGR.dim}${linesAddedHint + SGR.reset}
  Total Lines Removed: ${SGR.red}- ${formatInteger(totalRemoved)} lines ${SGR.reset}${SGR.dim}${linesRemovedHint + SGR.reset}
${contributionLine}
  Most Active Branch:  ${SGR.cyan}${topBranch}${SGR.reset} (${maxCommits} commits)
  First Commit:        ${SGR.yellow}${firstCommitTime}${SGR.reset}
  Last Commit:         ${SGR.yellow}${lastCommitTime}${SGR.reset}`);

      if (languageCatalog) {
         const languageLabel =
            resolvedLanguageMetricMode === 'net' ? 'Language Usage:' : 'Language Activity:';
         const legendLabel =
            resolvedLanguageMetricMode === 'net' ? '(Net changes)' : '(Aggregated changes)';
         const languageBarWidth = MathKit.clamp(global.terminalWidth - 21 - 2 - 2, 24, 56);
         const languageFiles =
            resolvedLanguageMetricMode === 'net'
               ? scopedNumStat.netFiles.map((file) => ({
                    filePath: file.filePath,
                    lines: file.netLines,
                 }))
               : scopedNumStat.activityFiles.map((file) => ({
                    filePath: file.filePath,
                    lines: file.activityLines,
                 }));
         const usageBar = renderLanguageUsageBar(languageCatalog, languageFiles, languageBarWidth);

         if (usageBar) {
            const languageBarPrefix =
               '  ' + strJustify(languageLabel, 21, { align: 'left', redundancyLv: -1 });
            const usageLegendPrefix =
               '  ' + strJustify(legendLabel, 21, { align: 'left', redundancyLv: -1 });
            quickPrint(
               `${languageBarPrefix}${usageBar.bar}\n${SGR.dim + usageLegendPrefix + SGR.reset}${usageBar.legend}${SGR.reset}\n`
            );
         }
      }

      await graph({
         ...ctx,
         args: isAllScope ? argsSet(['--quiet', '--all']) : argsSet(['--quiet', '--email', email]),
      });
      return 0;
   } catch (err) {
      spinnerCtrl.stop();
      exec.abort();
      Logger.error(yuString(err, { color: true }));
      return 1;
   }
}

/**
 * Parses repository remote metadata into link-ready information.
 *
 * @param normalizedRemoteUrl - Normalized remote URL in host/path form.
 * @returns Derived host, provider, and canonical repository URL.
 */
function buildRemoteLinkInfo(normalizedRemoteUrl: string | null): RemoteLinkInfo {
   if (!normalizedRemoteUrl) return { repoUrl: null, host: null, provider: null };

   const normalized = normalizedRemoteUrl.trim();
   if (!normalized) return { repoUrl: null, host: null, provider: null };

   const firstSlash = normalized.indexOf('/');
   const host = firstSlash === -1 ? normalized : normalized.slice(0, firstSlash);
   const repoPath = firstSlash === -1 ? '' : normalized.slice(firstSlash + 1);

   const isHostLike = host.includes('.') || host.includes(':') || host === 'localhost';
   const remoteHost = isHostLike ? host : null;
   const repoUrl = remoteHost && repoPath ? `https://${remoteHost}/${repoPath}` : null;
   const loweredHost = remoteHost ? remoteHost.toLowerCase() : '';
   let provider: RemoteLinkInfo['provider'] = null;
   if (loweredHost.includes('github')) provider = 'github';
   else if (loweredHost.includes('gitlab')) provider = 'gitlab';
   else if (loweredHost.includes('gitea')) provider = 'gitea';

   return {
      repoUrl,
      host: remoteHost,
      provider,
   };
}

/**
 * Parses numstat output grouped by author identity and returns the top contributor.
 *
 * @param raw - Raw output from `git log --format=%aN%x09%ae --numstat`.
 * @param projectChangedLines - Total changed lines across the project scope.
 * @returns Top contributor metadata or null when unavailable.
 */
function parseTopContributor(raw: string, projectChangedLines: number): TopContributor | null {
   if (!raw.trim()) return null;

   const contributors = new Map<string, { name: string; email: string; lines: number }>();
   let currentEmail = '';
   let currentName = '';

   for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const parts = line.split('\t');
      if (parts.length >= 3) {
         if (!/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) {
            continue;
         }

         if (!currentEmail) continue;

         const changedLines = parseInt(parts[0], 10) + parseInt(parts[1], 10);
         if (changedLines <= 0) continue;

         const filePath = normalizeNumStatPath(parts.slice(2).join('\t').trim());
         if (KNOWN_GIT_FAULT_FILE_HEURISTICS.includes(path.extname(filePath).toLowerCase())) {
            continue;
         }

         const identityKey = buildContributorIdentityKey(currentName, currentEmail);
         const existing = contributors.get(identityKey);
         if (existing) {
            existing.lines += changedLines;
            if (!existing.name && currentName) existing.name = currentName;
            if (!existing.email && currentEmail) existing.email = currentEmail;
         } else {
            contributors.set(identityKey, {
               name: currentName,
               email: currentEmail,
               lines: changedLines,
            });
         }

         continue;
      }

      const tabIdx = line.lastIndexOf('\t');
      if (tabIdx > 0) {
         currentName = line.slice(0, tabIdx).trim().replace(/^"|"$/g, '').replace(/^'|'$/g, '');
         currentEmail = line
            .slice(tabIdx + 1)
            .trim()
            .replace(/^"|"$/g, '')
            .replace(/^'|'$/g, '');
      } else {
         currentName = '';
         currentEmail = trimmed.replace(/^"|"$/g, '').replace(/^'|'$/g, '');
      }
   }

   let topEmail = '';
   let topName = '';
   let topLines = 0;
   for (const [, contributor] of contributors.entries()) {
      if (contributor.lines > topLines) {
         topEmail = contributor.email;
         topName = contributor.name;
         topLines = contributor.lines;
      }
   }

   if (!topEmail) return null;

   return {
      email: topEmail,
      username: topName || topEmail,
      contributionPct:
         projectChangedLines > 0
            ? maxFraction((topLines / projectChangedLines) * 100, 2, true)
            : '0.00',
   };
}

/**
 * Builds a stable identity key for contributor grouping.
 *
 * @param authorName - Commit author name.
 * @param authorEmail - Commit author email.
 * @returns Canonical grouping key.
 */
function buildContributorIdentityKey(authorName: string, authorEmail: string): string {
   const normalizedEmail = authorEmail.trim().toLowerCase();
   if (normalizedEmail) return `email:${normalizedEmail}`;

   const normalizedName = authorName.trim().toLowerCase();
   if (normalizedName) return `name:${normalizedName}`;
   return 'unknown';
}

/**
 * Formats a displayed username as a terminal hyperlink when remote metadata allows it.
 *
 * @param displayName - Name text to display.
 * @param remoteInfo - Parsed remote link metadata.
 * @returns Hyperlinked display name when possible; otherwise plain text.
 */
function formatUsernameWithProfileLink(displayName: string, remoteInfo: RemoteLinkInfo): string {
   const profileUsername = sanitizeDisplayUsername(displayName);
   const profileUrl = buildUserProfileUrl(profileUsername, remoteInfo);
   if (!profileUrl) return displayName;
   return hyperlink(displayName, profileUrl, false);
}

/**
 * Normalizes display text into a clean username token.
 *
 * @param value - Raw display value.
 * @returns Username token suitable for profile URL paths.
 */
function sanitizeDisplayUsername(value: string): string {
   return value.trim().replace(/"/g, '').replace(/'s$/i, '');
}

/**
 * Builds a user profile URL for supported forge providers.
 *
 * @param username - Candidate username.
 * @param remoteInfo - Parsed remote metadata.
 * @returns Fully-qualified profile URL or null.
 */
function buildUserProfileUrl(username: string, remoteInfo: RemoteLinkInfo): string | null {
   if (!username || !remoteInfo.host || !remoteInfo.provider) return null;
   return `https://${remoteInfo.host}/${username}`;
}

export const help = {
   long: () => {
      return strWrap(
         litedent`
         ${SGR.bright + _2PointGradient('STATS', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         Gather detailed contribution statistics for a git author in this repository.

         ${SGR.bright + _2PointGradient('WHAT IT COMPUTES', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         Total commits by the selected scope, today's commits, lines added/removed, rough size estimates (bytes), estimated functions/files added or removed, contribution percentage of the project, most active branch, language bar (activity or net), and time of the last commit. In project-wide mode, it also shows total object count/size and garbage object count/size (objects that would be pruned by ${SGR.cyan}git gc${SGR.reset}).

         ${SGR.bright + _2PointGradient('HOW IT WORKS', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         The command runs multiple git queries in parallel to collect commit lists, per-commit numstat, branch lists and last-commit metadata. For large repos this may take some time; progress messages are shown while queries run.

         ${SGR.bright + _2PointGradient('OPTIONS', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         Use ${SGR.cyan}--author <email>${SGR.reset} to target a different author than the configured git user.email. Use ${SGR.cyan}--all${SGR.reset} or ${SGR.cyan}-a${SGR.reset} for project-wide stats across all authors. Use ${SGR.cyan}--lang-metric <auto|net|activity>${SGR.reset} to choose whether the language bar reflects net lines (added - removed), activity (added + removed), or automatic mode (project-wide net, author activity). Output includes a small visual graph invocation via the \`${SGR.cyan}graph${SGR.reset}\` command by default.
         `,
         Math.min(100, global.terminalWidth - 4),
         {
            firstIndent: '  ',
            mode: 'softboundary',
            indent: '  ',
         }
      );
   },
   short: 'Show contribution statistics for an author or the whole project.',
   usage: () => {
      return strWrap(
         litedent`
         ${SGR.cyan}${EXECUTABLE_NAME} stats ${SGR.dim}[--author <email>] [--all|-a] [--lang-metric <auto|net|activity>]${SGR.reset}

         Examples:
            ${SGR.cyan}${EXECUTABLE_NAME} stats ${SGR.reset + SGR.dim}# Stats for configured git user${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} stats --author alice@example.com ${SGR.reset + SGR.dim}# Stats for specified author${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} stats --all ${SGR.reset + SGR.dim}# Project-wide stats for all authors${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} stats --lang-metric net ${SGR.reset + SGR.dim}# Force net language usage in author scope${SGR.reset}`,
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
   $root: ['--author', '--all', '-a', '--lang-metric'],
} as const satisfies CommandStructure;

/**
 * Parses git numstat output and accumulates changed lines per file.
 *
 * @param raw - Raw output from `git log --numstat`.
 * @returns Aggregated totals and file-level net deltas.
 */
function parseNumStat(raw: string): ParsedNumStat {
   let totalAdded = 0;
   let totalRemoved = 0;
   const fileNetLines = new Map<string, number>();
   const fileActivityLines = new Map<string, number>();
   const lines = raw.split('\n');

   for (const line of lines) {
      const parts = line.split('\t');
      if (parts.length < 3) continue;

      const [addedRaw, removedRaw] = parts;
      if (!/^\d+$/.test(addedRaw) || !/^\d+$/.test(removedRaw)) continue;

      const added = parseInt(addedRaw, 10);
      const removed = parseInt(removedRaw, 10);
      const changed = added + removed;
      if (changed <= 0) continue;

      const filePath = normalizeNumStatPath(parts.slice(2).join('\t').trim());
      if (KNOWN_GIT_FAULT_FILE_HEURISTICS.includes(path.extname(filePath).toLowerCase())) continue;

      totalAdded += added;
      totalRemoved += removed;

      fileActivityLines.set(filePath, (fileActivityLines.get(filePath) ?? 0) + changed);

      const net = added - removed;
      if (net === 0) continue;

      fileNetLines.set(filePath, (fileNetLines.get(filePath) ?? 0) + net);
   }

   const netFiles = Array.from(fileNetLines.entries()).map(([filePath, netLines]) => ({
      filePath,
      netLines,
   }));
   const activityFiles = Array.from(fileActivityLines.entries()).map(
      ([filePath, activityLines]) => ({
         filePath,
         activityLines,
      })
   );

   return {
      totalAdded,
      totalRemoved,
      totalRecords: lines.length,
      netFiles,
      activityFiles,
   };
}

/**
 * Resolves a representative file path from numstat output.
 *
 * @param filePath - Raw numstat path segment.
 * @returns Normalized path used for extension-based language inference.
 */
function normalizeNumStatPath(filePath: string): string {
   const renameSeparator = filePath.lastIndexOf('=>');
   if (renameSeparator === -1) return filePath;

   let normalized = filePath.slice(renameSeparator + 2).trim();
   if (normalized.startsWith('{')) normalized = normalized.slice(1);
   if (normalized.endsWith('}')) normalized = normalized.slice(0, -1);
   return normalized.trim();
}

/**
 * Counts garbage objects from `git fsck` output.
 *
 * Garbage objects are unreachable or dangling objects that are candidates for pruning by `git gc`.
 *
 * @param fsckStdout - Standard output from `git fsck`.
 * @param fsckStderr - Standard error from `git fsck`.
 * @returns Total garbage object metadata and IDs.
 */
function countGarbageObjects(fsckStdout: string, fsckStderr: string): GarbageObjectStats {
   const objectIds: Set<string> = new Set();
   const fsckOutput = `${fsckStdout}\n${fsckStderr}`;
   const objectCounts: Record<string, number> = {};

   for (const line of fsckOutput.split('\n')) {
      const matched = line.trim().match(/^(?:unreachable|dangling) (\w+) ([0-9a-f]{40})$/i);
      if (!matched) continue;

      const objectId = matched[2].toLowerCase();
      if (!objectIds.has(objectId)) {
         objectIds.add(objectId);
         const type = matched[1].toLowerCase();
         objectCounts[type] = (objectCounts[type] || 0) + 1;
      }
   }

   return {
      total: objectIds.size,
      commit: objectCounts.commit || 0,
      objectIds,
   };
}

/**
 * Summarizes all object sizes and intersects them with garbage object IDs.
 *
 * @param raw - Output from `git cat-file --batch-all-objects --batch-check`.
 * @param garbageObjectIds - Set of garbage object IDs from fsck.
 * @returns Object counts and byte sizes for total and garbage subsets.
 */
function summarizeObjectInventory(
   raw: string,
   garbageObjectIds: Set<string>
): ObjectInventoryStats {
   let totalObjects = 0;
   let totalBytes = 0;
   let garbageBytes = 0;

   for (const line of raw.split('\n')) {
      const matched = line.trim().match(/^([0-9a-f]{40}):(\d+)$/i);
      if (!matched) continue;

      const objectId = matched[1].toLowerCase();
      const objectSize = parseInt(matched[2], 10);
      totalObjects += 1;
      totalBytes += objectSize;

      if (garbageObjectIds.has(objectId)) {
         garbageBytes += objectSize;
      }
   }

   return {
      totalObjects,
      totalBytes,
      garbageObjects: garbageObjectIds.size,
      garbageBytes,
   };
}

/**
 * Formats integer values with US separators for stats output.
 *
 * @param value - Numeric value to format.
 * @returns String representation using grouped thousands.
 */
function formatInteger(value: number): string {
   return Math.max(0, Math.trunc(value)).toLocaleString('en-US');
}

/**
 * Builds a colored language usage bar and legend text.
 *
 * @param catalog - Language catalog used for extension lookup.
 * @param languageFiles - Line totals grouped by file path for selected metric.
 * @param barWidth - Target bar width in visible columns.
 * @returns Renderable bar and legend or null when no changes exist.
 */
function renderLanguageUsageBar(
   catalog: LanguageCatalog,
   languageFiles: Array<{ filePath: string; lines: number }>,
   barWidth: number
): LanguageUsageBar | null {
   if (barWidth <= 0) return null;

   let othersLines = 0;
   const languageLines = new Map<string, { name: string; color: number; lines: number }>();

   for (const file of languageFiles) {
      const language = inferLanguageFromPath(catalog, file.filePath);
      if (!language) {
         othersLines += file.lines;
         continue;
      }

      const current = languageLines.get(language.name);
      if (current) {
         current.lines += file.lines;
      } else {
         languageLines.set(language.name, {
            name: language.name,
            color: language.color,
            lines: file.lines,
         });
      }
   }

   const positiveLanguageLines = [...languageLines.values()].filter(
      (language) => language.lines > 0
   );
   const baseOthersLines = Math.max(0, othersLines);
   const totalLines =
      positiveLanguageLines.reduce((sum, language) => sum + language.lines, 0) + baseOthersLines;
   if (totalLines <= 0) return null;

   const visibleBuckets: {
      name: string;
      color: number;
      lines: number;
      cols: number;
      remainder: number;
      isOthers: boolean;
   }[] = [];

   let collapsedOthersLines = baseOthersLines;
   for (const lang of positiveLanguageLines) {
      const rawCols = (lang.lines / totalLines) * barWidth;
      if (rawCols < 1) {
         collapsedOthersLines += lang.lines;
         continue;
      }

      const wholeCols = Math.floor(rawCols);
      visibleBuckets.push({
         name: lang.name,
         color: lang.color,
         lines: lang.lines,
         cols: wholeCols,
         remainder: rawCols - wholeCols,
         isOthers: false,
      });
   }

   if (collapsedOthersLines > 0) {
      const rawCols = (collapsedOthersLines / totalLines) * barWidth;
      const wholeCols = Math.floor(rawCols);
      visibleBuckets.push({
         name: 'Others',
         color: DEFAULT_LANGUAGE_COLOR,
         lines: collapsedOthersLines,
         cols: wholeCols,
         remainder: rawCols - wholeCols,
         isOthers: true,
      });
   }

   if (visibleBuckets.length === 0) return null;

   const othersBucket = visibleBuckets.find((bucket) => bucket.isOthers);
   if (othersBucket && othersBucket.cols === 0) {
      othersBucket.cols = 1;
      othersBucket.remainder = 0;
   }

   let usedCols = visibleBuckets.reduce((sum, bucket) => sum + bucket.cols, 0);
   if (usedCols > barWidth) {
      const shrinkable = visibleBuckets
         .filter((bucket) => !bucket.isOthers)
         .sort((a, b) => b.cols - a.cols);

      for (const bucket of shrinkable) {
         while (usedCols > barWidth && bucket.cols > 1) {
            bucket.cols -= 1;
            usedCols -= 1;
         }
         if (usedCols <= barWidth) break;
      }
   }

   if (usedCols > barWidth && othersBucket && othersBucket.cols > 1) {
      while (usedCols > barWidth && othersBucket.cols > 1) {
         othersBucket.cols -= 1;
         usedCols -= 1;
      }
   }

   let remaining = barWidth - usedCols;
   if (remaining > 0) {
      const byRemainder = [...visibleBuckets].sort((a, b) => b.remainder - a.remainder);
      let idx = 0;
      while (remaining > 0 && byRemainder.length > 0) {
         byRemainder[idx % byRemainder.length].cols += 1;
         remaining -= 1;
         idx += 1;
      }
   }

   const renderedBuckets = visibleBuckets
      .filter((bucket) => bucket.cols > 0)
      .sort((a, b) => b.lines - a.lines);

   const topThreshold = totalLines * 0.18;
   const [topBuckets, otherBuckets] = routeItems(renderedBuckets.slice(0, 6), (bucket, i) => {
      if (bucket.lines >= topThreshold) return 0;
      if (i === 0) return 0;
      return 1;
   });
   const topBucketPcts = topBuckets!.map((bucket) =>
      maxFraction((bucket.lines / totalLines) * 100, 1, true)
   );

   const bar =
      renderedBuckets
         .map((bucket) => `${ncc(bucket.color, 'fg')}${'━'.repeat(bucket.cols)}`)
         .join('') + SGR.reset;

   const legend =
      topBuckets!
         .map(
            (bucket, i) =>
               `${ncc(bucket.color, 'fg')}●${SGR.reset} ${topBucketPcts[i]}% ${bucket.name}`
         )
         .join(' ') +
      SGR.dim +
      ' ' +
      (otherBuckets
         ? otherBuckets
              .map((bucket) => `${ncc(bucket.color, 'fg')}●${SGR.white} ${bucket.name}`)
              .join(' ')
         : '');

   return { bar, legend };
}

/**
 * Parses and validates the requested language metric mode.
 *
 * @param value - Raw CLI value from `--lang-metric`.
 * @param hasOption - Whether the option token was present.
 * @returns Parsed mode or null when invalid.
 */
function parseLanguageMetricMode(
   value: string | null,
   hasOption: boolean
): LanguageMetricMode | null {
   if (!hasOption) return 'auto';
   if (!value) return null;

   const normalized = value.trim().toLowerCase();
   if (normalized === 'auto' || normalized === 'net' || normalized === 'activity') {
      return normalized;
   }
   return null;
}

/**
 * Resolves the effective language metric mode.
 *
 * @param mode - User-selected metric mode.
 * @param isAllScope - Whether stats are project-wide.
 * @returns Effective render mode.
 */
function resolveLanguageMetricMode(
   mode: LanguageMetricMode,
   isAllScope: boolean
): ResolvedLanguageMetricMode {
   if (mode === 'auto') return isAllScope ? 'net' : 'activity';
   return mode;
}
