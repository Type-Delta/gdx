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
   KNOWN_GIT_FAULT_FILE_HUBRISTICS,
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

interface ParsedNumStat {
   totalAdded: number;
   totalRemoved: number;
   totalRecords: number;
   changedFiles: Array<{ filePath: string; changedLines: number }>;
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

export default async function stats(ctx: GdxContext): Promise<number> {
   const exec = createAbortableExec();
   const $ = exec.$;

   const { args, git$ } = ctx;

   if (!(await assertInGitWorktree(git$))) return 1;

   const isAllScope = args.hasOption('--all') || args.hasOption('-a');
   args.popOption('--all');
   args.popOption('-a');

   let email = '';
   let username = 'Your';
   let scopeLabel = '';

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
      const orphanCommitsPromise = $`${git$} rev-list --all --max-parents=0 --count`;
      const projectLineStatsPromise = $`${git$} log --all --pretty=tformat: --numstat`;
      const firstCommitFormat = `%ar ${ncc() + ncc('Dim')}[at %h] (on %ad)` + ncc();
      const lastCommitFormat = `%ar ${ncc() + ncc('Dim')}[at %h] (on %ad)` + ncc();
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
         orphanCommitsRes,
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
      ] = await Promise.all([
         isAllScope ? projectTotalCmiPromise : $`${git$} rev-list --all --count --author=${email}`,
         projectTotalCmiPromise,
         orphanCommitsPromise,
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
      const scopedTotalCmi = scopedTotalCmiRes.stdout.trim();
      const projectTotalCmi = projectTotalCmiRes.stdout.trim();
      const orphanCommits = parseInt(orphanCommitsRes.stdout.trim(), 10) || 0;
      const todayCommits = todayCommitsRes.stdout.trim()
         ? todayCommitsRes.stdout.trim().split('\n').length
         : 0;

      spinnerCtrl.setMessage('Detecting repository details...');
      const submoduleCount = submodules.length;
      const projectSuffix =
         submoduleCount > 0 ? ncc('Dim') + ncc('White') + ` (${submoduleCount} submodules)` : '';

      const remoteLinkInfo = buildRemoteLinkInfo(normalizedRemoteUrl);
      const linkedProjectName = remoteLinkInfo.repoUrl
         ? `${hyperlink(projectName, remoteLinkInfo.repoUrl, false)}${projectSuffix}`
         : `${projectName}${projectSuffix}`;

      const statParseStart = performance.now();
      const projectNumStat = parseNumStat(projectLineStatsRes.stdout);
      const scopedNumStat = isAllScope ? projectNumStat : parseNumStat(scopedLogStatsRes.stdout);

      const totalAdded = scopedNumStat.totalAdded;
      const totalRemoved = scopedNumStat.totalRemoved;

      const addedSize = toShortNum(totalAdded * STATS_EST.AVG_CHARS_PER_LINE, 2, 1024) + 'iB';
      const removedSize = toShortNum(totalRemoved * STATS_EST.AVG_CHARS_PER_LINE, 2, 1024) + 'iB';

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
      const orphanColor = orphanCommits > 0 ? ncc('Red') : ncc('White') + ncc('Dim');
      const orphanLabel = `${orphanCommits} ${ncc('White') + ncc('Dim')}orphan${orphanCommits === 1 ? '' : 's'}`;
      const totalCommitsSuffix = isAllScope
         ? ` / ${orphanColor}${orphanLabel}${ncc()}`
         : ` / ${ncc('Yellow')}${projectTotalCmi}${ncc() + ncc('Dim')} all${ncc()} / ${orphanColor}${orphanLabel}${ncc()}`;
      const contributionLine = isAllScope
         ? `  Most Active User:    ${ncc('Cyan')}${linkedTopContributor}${ncc()} (${ncc('Magenta')}${contributionPct}%${ncc()} of all lines changed in the project)`
         : `  Contributions:       ${ncc('Magenta')}${contributionPct}%${ncc()} of all lines changed in the project`;
      const header = [
         `${ncc('Dim') + ncc('Italic')}Showing stats for ${scopeLabel} in ${projectName}${ncc()}`,
         `${ncc('Dim')}Parsed ${toShortNum(numStatSize, 1, 1024)}iB of ${toShortNum(recordsParsed, 1, 1e3, true)} numstat records in ${parseDuration}${ncc()}`,
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

      spinnerCtrl.stop();
      quickPrint(`${headerText}

  ─── ${usernameWithLink} Git Stats ───
  Project:             ${ncc('Cyan')}${linkedProjectName}${ncc()}
  Total Commits:       ${ncc('Green')}${scopedTotalCmi}${ncc()} (today: ${todayCommits})${totalCommitsSuffix}
  Total Lines Added:   ${ncc('Green')}+ ${totalAdded} lines ${ncc()}${ncc('Dim')}${linesAddedHint + ncc()}
  Total Lines Removed: ${ncc('Red')}- ${totalRemoved} lines ${ncc()}${ncc('Dim')}${linesRemovedHint + ncc()}
${contributionLine}
  Most Active Branch:  ${ncc('Cyan')}${topBranch}${ncc()} (${maxCommits} commits)
  First Commit:        ${ncc('Yellow')}${firstCommitTime}${ncc()}
  Last Commit:         ${ncc('Yellow')}${lastCommitTime}${ncc()}`);

      if (languageCatalog) {
         const LANGUAGE_BAR_PREFIX = '  Language Usage:      ';
         const languageBarWidth = Math.max(
            24,
            Math.min(56, global.terminalWidth - LANGUAGE_BAR_PREFIX.length - 2)
         );
         const usageBar = renderLanguageUsageBar(
            languageCatalog,
            scopedNumStat.changedFiles,
            totalChanged,
            languageBarWidth
         );

         if (usageBar) {
            const usageLegendPrefix = ' '.repeat(LANGUAGE_BAR_PREFIX.length);
            quickPrint(
               `${LANGUAGE_BAR_PREFIX}${usageBar.bar}\n${usageLegendPrefix}${usageBar.legend}\n`
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
         if (KNOWN_GIT_FAULT_FILE_HUBRISTICS.includes(path.extname(filePath).toLowerCase())) {
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
      const bright = ncc('Bright');
      const cyan = ncc('Cyan');
      const reset = ncc();
      return strWrap(
         `
${bright + _2PointGradient('STATS', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
Gather detailed contribution statistics for a git author in this repository.

${bright + _2PointGradient('WHAT IT COMPUTES', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
Total commits by the selected scope, today's commits, lines added/removed, rough size estimates (bytes), estimated functions/files added or removed, contribution percentage of the project, most active branch, language usage by modified lines, and time of the last commit.

${bright + _2PointGradient('HOW IT WORKS', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
The command runs multiple git queries in parallel to collect commit lists, per-commit numstat, branch lists and last-commit metadata. For large repos this may take some time; progress messages are shown while queries run.

${bright + _2PointGradient('OPTIONS', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
Use ${cyan}--author <email>${reset} to target a different author than the configured git user.email. Use ${cyan}--all${reset} or ${cyan}-a${reset} for project-wide stats across all authors. Output includes a small visual graph invocation via the \`${cyan}graph${reset}\` command by default.
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
      const cyan = ncc('Cyan');
      const dim = ncc('Dim');
      const reset = ncc();
      return strWrap(
         `
${cyan}${EXECUTABLE_NAME} stats ${dim}[--author <email>] [--all|-a]${reset}

Examples:
   ${cyan}${EXECUTABLE_NAME} stats ${reset + dim}# Stats for configured git user${reset}
   ${cyan}${EXECUTABLE_NAME} stats --author alice@example.com ${reset + dim}# Stats for specified author${reset}
   ${cyan}${EXECUTABLE_NAME} stats --all ${reset + dim}# Project-wide stats for all authors${reset}`,
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
   $root: ['--author', '--all', '-a'],
} as const satisfies CommandStructure;

/**
 * Parses git numstat output and accumulates changed lines per file.
 *
 * @param raw - Raw output from `git log --numstat`.
 * @returns Aggregated totals and file-level changes.
 */
function parseNumStat(raw: string): ParsedNumStat {
   let totalAdded = 0;
   let totalRemoved = 0;
   const changedFiles: Array<{ filePath: string; changedLines: number }> = [];
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
      if (KNOWN_GIT_FAULT_FILE_HUBRISTICS.includes(path.extname(filePath).toLowerCase())) continue;

      totalAdded += added;
      totalRemoved += removed;
      changedFiles.push({
         filePath,
         changedLines: changed,
      });
   }

   return {
      totalAdded,
      totalRemoved,
      totalRecords: lines.length,
      changedFiles,
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
 * Builds a colored language usage bar and legend text.
 *
 * @param catalog - Language catalog used for extension lookup.
 * @param changedFiles - Changed lines grouped by file path.
 * @param totalChanged - Total changed lines in selected scope.
 * @param barWidth - Target bar width in visible columns.
 * @returns Renderable bar and legend or null when no changes exist.
 */
function renderLanguageUsageBar(
   catalog: LanguageCatalog,
   changedFiles: Array<{ filePath: string; changedLines: number }>,
   totalChanged: number,
   barWidth: number
): LanguageUsageBar | null {
   if (totalChanged <= 0 || barWidth <= 0) return null;

   let othersLines = 0;
   const languageLines = new Map<string, { name: string; color: number; lines: number }>();

   for (const file of changedFiles) {
      const language = inferLanguageFromPath(catalog, file.filePath);
      if (!language) {
         othersLines += file.changedLines;
         continue;
      }

      const current = languageLines.get(language.name);
      if (current) {
         current.lines += file.changedLines;
      } else {
         languageLines.set(language.name, {
            name: language.name,
            color: language.color,
            lines: file.changedLines,
         });
      }
   }

   const visibleBuckets: {
      name: string;
      color: number;
      lines: number;
      cols: number;
      remainder: number;
      isOthers: boolean;
   }[] = [];

   for (const lang of languageLines.values()) {
      const rawCols = (lang.lines / totalChanged) * barWidth;
      if (rawCols < 1) {
         othersLines += lang.lines;
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

   if (othersLines > 0) {
      const rawCols = (othersLines / totalChanged) * barWidth;
      const wholeCols = Math.floor(rawCols);
      visibleBuckets.push({
         name: 'Others',
         color: DEFAULT_LANGUAGE_COLOR,
         lines: othersLines,
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

   const topThreshold = totalChanged * 0.18;
   const [topBuckets, otherBuckets] = routeItems(renderedBuckets.slice(0, 6), (bucket, i) => {
      if (bucket.lines >= topThreshold) return 0;
      if (i === 0) return 0;
      return 1;
   });
   const topBucketPcts = topBuckets!.map((bucket) =>
      maxFraction((bucket.lines / totalChanged) * 100, 1, true)
   );

   const bar =
      renderedBuckets
         .map((bucket) => `${ncc(bucket.color, 'fg')}${'━'.repeat(bucket.cols)}`)
         .join('') + ncc();

   const legend =
      topBuckets!
         .map(
            (bucket, i) => `${ncc(bucket.color, 'fg')}●${ncc()} ${topBucketPcts[i]}% ${bucket.name}`
         )
         .join(' ') +
      ncc('Dim') +
      ' ' +
      (otherBuckets
         ? otherBuckets
              .map((bucket) => `${ncc(bucket.color, 'fg')}●${ncc('White')} ${bucket.name}`)
              .join(' ')
         : '');

   return { bar, legend };
}
