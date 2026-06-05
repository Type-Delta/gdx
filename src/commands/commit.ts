import * as fs from '@/modules/fs';
import path from 'path';
import crypto from 'crypto';

import { DataScienceKit, Err, SafeTrue, strWrap, yuString } from '@lib/Tools';

import { GdxContext } from '@/common/types';
import { $, $inherit, copyToClipboard, spinner, redrawText } from '@/modules/shell';
import { asUnixPath } from '@/utils/path';
import { noop, quickPrint } from '@/utils/utilities';
import { getLLMProvider } from '@/common/adapters/llm';
import Logger from '@/utils/logger';
import {
   commitMsgGenerator,
   commitMsgGeneratorInherent,
   guidelineLearningPrompt,
} from '@/templates/prompts';
import {
   COMMIT_EXAMPLE_LIMIT,
   COMMIT_HEADER_PREFIX_LENGTH,
   COMMIT_HEADER_SAMPLE_LIMIT,
   COMMIT_MEDOID_SAMPLE_LIMIT,
   EXECUTABLE_NAME,
   TEMP_DIR,
   GDX_VPALETTE,
   SGR,
} from '@/consts';
import { _2PointGradient } from '@/modules/graphics';
import global from '@/global';
import { getConfig } from '@/common/config';
import { getCache } from '@/common/cache';
import { assertInGitWorktree, getMainWorktreeRoot, getNormalizedRemoteUrl } from '@/modules/git';
import { buildStagedCommitDiffSummary } from '@/modules/diff-summary';
import litedent from '@/utils/litedent';

/**
 * Generates a hash for the given value.
 */
function createHash(value: string): string {
   return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

interface CommitHeaderSample {
   hash: string;
   header: string;
}

/**
 * Returns the fixed-length header prefix used for style comparison.
 */
function getHeaderPrefix(header: string): string {
   return header.slice(0, COMMIT_HEADER_PREFIX_LENGTH);
}

/**
 * Computes string distance from LCS length on header prefixes.
 */
function getHeaderPrefixDistance(left: string, right: string): number {
   const leftPrefix = getHeaderPrefix(left);
   const rightPrefix = getHeaderPrefix(right);
   const maxLength = Math.max(leftPrefix.length, rightPrefix.length, 1);
   const lcsLength = DataScienceKit.LCSLength_of(leftPrefix, rightPrefix);
   return maxLength - lcsLength;
}

/**
 * Finds the medoid header prefix by minimizing average pairwise distance.
 */
function findHeaderMedoidPrefix(headers: string[]): string | null {
   if (headers.length === 0) return null;
   if (headers.length === 1) return getHeaderPrefix(headers[0]);

   let bestIndex = 0;
   let bestAverageDistance = Number.POSITIVE_INFINITY;

   for (let i = 0; i < headers.length; i++) {
      let totalDistance = 0;
      for (let j = 0; j < headers.length; j++) {
         if (i === j) continue;
         totalDistance += getHeaderPrefixDistance(headers[i], headers[j]);
      }

      const averageDistance = totalDistance / (headers.length - 1);
      if (averageDistance < bestAverageDistance) {
         bestAverageDistance = averageDistance;
         bestIndex = i;
      }
   }

   return getHeaderPrefix(headers[bestIndex]);
}

/**
 * Selects diverse commit samples using farthest-point sampling from a seed prefix.
 */
function farthestPointSampleCommits(
   samples: CommitHeaderSample[],
   seedPrefix: string,
   limit: number
): CommitHeaderSample[] {
   if (samples.length === 0 || limit <= 0) return [];

   const targetCount = Math.min(limit, samples.length);
   const selectedIndexes: number[] = [];
   const selectedSet = new Set<number>();

   // Start from sample nearest to the medoid prefix.
   let startIndex = 0;
   let bestSeedDistance = Number.POSITIVE_INFINITY;
   for (let i = 0; i < samples.length; i++) {
      const distance = getHeaderPrefixDistance(seedPrefix, samples[i].header);
      if (distance < bestSeedDistance) {
         bestSeedDistance = distance;
         startIndex = i;
      }
   }

   selectedIndexes.push(startIndex);
   selectedSet.add(startIndex);

   const safety = new SafeTrue(samples.length * 4 + 8, true);
   while (safety.True && selectedIndexes.length < targetCount) {
      let bestCandidateIndex = -1;
      let bestCandidateSpread = Number.NEGATIVE_INFINITY;

      for (let i = 0; i < samples.length; i++) {
         if (selectedSet.has(i)) continue;

         let minDistanceToSelected = Number.POSITIVE_INFINITY;
         for (const selectedIndex of selectedIndexes) {
            const distance = getHeaderPrefixDistance(
               samples[i].header,
               samples[selectedIndex].header
            );
            if (distance < minDistanceToSelected) {
               minDistanceToSelected = distance;
            }
         }

         if (minDistanceToSelected > bestCandidateSpread) {
            bestCandidateSpread = minDistanceToSelected;
            bestCandidateIndex = i;
         }
      }

      if (bestCandidateIndex < 0) break;
      selectedIndexes.push(bestCandidateIndex);
      selectedSet.add(bestCandidateIndex);
   }

   return selectedIndexes.map((index) => samples[index]);
}

/**
 * Parses `git log` output encoded as `%H%x00%s%x1e`.
 */
function parseCommitHeaderSamples(rawOutput: string): CommitHeaderSample[] {
   return rawOutput
      .split('\x1e')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => {
         const separatorIndex = entry.indexOf('\x00');
         if (separatorIndex === -1) return null;

         const hash = entry.slice(0, separatorIndex).trim();
         const header = entry.slice(separatorIndex + 1).trim();
         if (!hash || !header) return null;

         return { hash, header };
      })
      .filter((sample): sample is CommitHeaderSample => sample !== null);
}

/**
 * Learns commit message guidelines from repository history.
 * Returns the guideline text or null if learning failed/not enough history.
 */
export async function learnCommitGuidelines(
   git$: string | string[]
): Promise<{ guideline: string | null; historyCount: number }> {
   quickPrint('');

   const spin = spinner({
      message: "learning this repo's commit style...",
      animateGradient: true,
   });

   try {
      // Step 1: sample recent commit headers (up to 50).
      const headerResult =
         await $`${git$} log --no-merges -n ${COMMIT_HEADER_SAMPLE_LIMIT} --format=%H%x00%s%x1e`;
      const headerSamples = parseCommitHeaderSamples(headerResult.stdout);

      if (headerSamples.length === 0) {
         spin.stop();
         return { guideline: null, historyCount: 0 };
      }

      // Step 2: compute medoid from latest 25 headers (or fewer if unavailable).
      const medoidCandidates = headerSamples.slice(
         0,
         Math.min(COMMIT_MEDOID_SAMPLE_LIMIT, headerSamples.length)
      );
      const medoidPrefix = findHeaderMedoidPrefix(medoidCandidates.map((sample) => sample.header));

      if (!medoidPrefix) {
         spin.stop();
         return { guideline: null, historyCount: 0 };
      }

      // Step 3: farthest-point sampling from the 50-header pool using medoid as the seed.
      const selectedSamples = farthestPointSampleCommits(
         headerSamples,
         medoidPrefix,
         COMMIT_EXAMPLE_LIMIT
      );
      const selectedHashes = selectedSamples.map((sample) => sample.hash);

      const averageMedoidDistance =
         selectedSamples.reduce((total, sample) => {
            return total + getHeaderPrefixDistance(medoidPrefix, sample.header);
         }, 0) / Math.max(selectedSamples.length, 1);
      const uniqueHeaderPrefixCount = new Set(
         selectedSamples.map((sample) => getHeaderPrefix(sample.header))
      ).size;

      Logger.debug(
         `Commit guideline sampling stats: pool50=${headerSamples.length}, medoidPool=${medoidCandidates.length}, selected=${selectedSamples.length}, uniquePrefix28=${uniqueHeaderPrefixCount}, avgDistanceToMedoid=${averageMedoidDistance.toFixed(2)}`,
         'commit'
      );
      Logger.debug(`Commit guideline medoid prefix(28): "${medoidPrefix}"`, 'commit');
      Logger.debug(
         `Commit guideline selected examples:\n${selectedSamples
            .map((sample, i) => `${i + 1}. ${sample.hash.slice(0, 10)} ${sample.header}`)
            .join('\n')}`,
         'commit'
      );

      if (selectedHashes.length === 0) {
         spin.stop();
         return { guideline: null, historyCount: 0 };
      }

      // Step 4: fetch full commit messages (header + body) for sampled commits.
      const fullMessagesResult = await $`${git$} show -s --format=%B%x00 ${selectedHashes}`;
      const samplesToUse = fullMessagesResult.stdout
         .split('\x00')
         .map((msg) => msg.trim())
         .filter((msg) => msg.length > 0)
         .slice(0, COMMIT_EXAMPLE_LIMIT);

      if (samplesToUse.length === 0) {
         spin.stop();
         return { guideline: null, historyCount: 0 };
      }

      // Ask LLM to learn the pattern
      const llm = await getLLMProvider();
      const guideline = await llm.generate({
         prompt: guidelineLearningPrompt(samplesToUse),
         temperature: 0.2,
         reasoning: 'medium',
      });

      spin.stop();
      return { guideline: guideline.trim(), historyCount: samplesToUse.length };
   } catch (error) {
      spin.stop();
      const err = Err.from(error);
      Logger.warn(`Failed to learn commit guidelines: ${err.message}`, 'commit');
      Logger.debug(`LLM error details: ${err}`, 'commit');
      return { guideline: null, historyCount: 0 };
   }
}

/**
 * Gets commit message guidelines for the current repository.
 * Uses cache if available, otherwise learns from history.
 */
async function getCommitGuidelines(
   git$: string | string[],
   config: Awaited<ReturnType<typeof getConfig>>
): Promise<string | null> {
   const cache = await getCache();
   const mainRepoRoot = await getMainWorktreeRoot(git$);
   const remoteUrl = await getNormalizedRemoteUrl(git$);
   const normalizedRepoRoot = asUnixPath(mainRepoRoot);
   const cacheDays = config.get<number>('commit.guidelineCacheDays', 30);
   const cacheMinutes = cacheDays * 24 * 60;

   const remoteHash = remoteUrl ? createHash(`remote:${remoteUrl}`) : '';
   const pathHash = createHash(`path:${normalizedRepoRoot}`);
   const remoteKey = remoteHash ? `commit.repoGuidelines.${remoteHash}` : '';
   const pathKey = `commit.repoGuidelines.${pathHash}`;

   if (remoteKey) {
      const cachedRemote = await cache.get<string>(remoteKey);
      if (cachedRemote) {
         Logger.debug(`Using cached commit guidelines for remote ${remoteUrl}`, 'commit');
         return cachedRemote;
      }
   }

   const cachedPath = await cache.get<string>(pathKey);
   if (cachedPath) {
      if (remoteKey) {
         await cache.set(remoteKey, cachedPath, { maxAgeMinutes: cacheMinutes });
         Logger.debug(`Promoted commit guidelines cache to remote ${remoteUrl}`, 'commit');
      } else {
         Logger.debug(`Using cached commit guidelines for ${normalizedRepoRoot}`, 'commit');
      }
      return cachedPath;
   }

   // Learn from repository history
   const { guideline, historyCount } = await learnCommitGuidelines(git$);

   if (!guideline || historyCount === 0) {
      Logger.warn(
         'No commit history found in this repository. Falling back to comprehensive format.',
         'commit'
      );
      return null;
   }

   if (historyCount < 5) {
      Logger.warn(
         // LINK: dii2ndk text literal in spec
         `Only ${historyCount} commit(s) found in history. The learned guidelines may be less accurate.`,
         'commit'
      );
   }

   // Cache the learned guideline
   const targetKey = remoteKey || pathKey;
   await cache.set(targetKey, guideline, { maxAgeMinutes: cacheMinutes });
   const cacheLabel = remoteKey ? `remote ${remoteUrl}` : normalizedRepoRoot;
   Logger.debug(`Cached commit guidelines for ${cacheLabel} (${cacheDays} days)`, 'commit');

   return guideline;
}

async function autoCommit(ctx: GdxContext): Promise<number> {
   const { git$, args } = ctx;

   if (!(await assertInGitWorktree(git$))) {
      quickPrint(
         `${SGR.red}Error: Not inside a Git repository. Please navigate to a repository and try again.${SGR.reset}`
      );
      return 1;
   }

   const passThruArgs = args.slice(2);
   const shouldNoCommit =
      passThruArgs.popOption('--no-commit') !== null || passThruArgs.popOption('-nc') !== null;
   const shouldCopy =
      passThruArgs.popOption('--copy') !== null || passThruArgs.popOption('-cp') !== null;
   const shouldYes =
      passThruArgs.popOption('--yes') !== null || passThruArgs.popOption('-y') !== null;
   const shouldPreview = passThruArgs.popOption('--preview') !== null;
   const userDescriptionRaw =
      passThruArgs.popValue('--describe') || passThruArgs.popValue('-d') || '';
   const userDescription = userDescriptionRaw.trim();

   if ((args.hasOption('--describe') || args.hasOption('-d')) && !userDescription) {
      Logger.warn('Ignoring --describe/-d because no description text was provided.', 'commit');
   }

   const config = await getConfig();
   const showThinking = config.get<boolean>('llm.showThinking', true);
   const commitPattern = config.get<'inherit' | 'comprehensive'>('commit.commitPattern', 'inherit');
   const noisyFilePatterns = config.get<string[]>('commit.noisyFiles', []);
   const resolvedNoisyPatterns = Array.isArray(noisyFilePatterns)
      ? noisyFilePatterns.filter((entry) => typeof entry === 'string')
      : [];

   const spin = spinner({
      message: 'compiling changes summary...',
   });
   const stagedSummary = await buildStagedCommitDiffSummary(git$, {
      noisyPatterns: resolvedNoisyPatterns,
   });
   spin.stop();

   if (!stagedSummary.hasChanges || stagedSummary.summary.trim().length === 0) {
      quickPrint(
         `${SGR.red}No staged changes found. Please stage your changes before generating a commit message.${SGR.reset}`
      );
      return 1;
   }

   // Determine which prompt to use based on pattern setting
   let prompt: string;
   if (commitPattern === 'inherit') {
      const guidelines = await getCommitGuidelines(git$, config);
      if (guidelines) {
         prompt = commitMsgGeneratorInherent(stagedSummary.summary, guidelines, userDescription);
      } else {
         // Fallback to comprehensive if learning failed
         prompt = commitMsgGenerator(stagedSummary.summary, userDescription);
      }
   } else {
      prompt = commitMsgGenerator(stagedSummary.summary, userDescription);
   }

   if (shouldPreview) {
      quickPrint(prompt);
      return 0;
   }

   quickPrint(`${SGR.cyan}Generating commit message based on staged changes...${SGR.reset}\n`);

   try {
      const llm = await getLLMProvider();

      const spin = spinner({
         message: 'connecting...',
         animateGradient: false,
      });

      const connection = llm.streamGenerate({
         prompt,
         temperature: 0.14,
         reasoning: 'low',
      });

      let generatedMsg = '';
      let hasReceivedContent = false;
      let isReasoning = false;
      let thinkingBuffer = '';

      for await (const response of connection) {
         if (response.error) {
            spin.stop();
            Logger.error(
               response.error.message + (response.error.cause ? ': ' + response.error.cause : ''),
               'commit'
            );
            Logger.debug(`LLM error details: ${Err.from(response.error)}`, 'commit');
            return 1;
         }

         if (response.thinkingChunk) {
            if (!isReasoning) {
               isReasoning = true;
               spin.options.animateGradient = true;
               if (!showThinking) spin.options.message = 'reasoning...';
            }

            if (showThinking) {
               thinkingBuffer = (
                  thinkingBuffer + response.thinkingChunk.replace(/[\n\r]/g, '')
               ).slice(-32);
               spin.options.message = `reasoning... ${thinkingBuffer.trim()}`;
            }
            continue;
         }

         if (response.chunk) {
            if (!hasReceivedContent) {
               hasReceivedContent = true;
               spin.stop();
               quickPrint(`${SGR.cyan}Generated Commit Message:${SGR.reset}`);
            }
            quickPrint(response.chunk, '');
            generatedMsg += response.chunk;
         }
      }

      if (!generatedMsg) {
         quickPrint('\n'); // 2 Final newline after message output
         Logger.error('Unable to generate commit message (empty response).', 'commit');
         return 1;
      }

      const originalMsg = generatedMsg;
      generatedMsg = generatedMsg.replace(/(^\s*["'`]*|["'`]*\s*$)/g, ''); // Remove surrounding quotes if any

      const titleBodySplit = generatedMsg.indexOf('\n');
      if (titleBodySplit !== -1) {
         const cmiTitle = generatedMsg.slice(0, titleBodySplit);
         const cmiBody = generatedMsg.slice(titleBodySplit + 1).trim();
         generatedMsg =
            cmiTitle +
            '\n\n' +
            strWrap(cmiBody, 72, {
               mode: 'softboundary',
               redundancyLv: -1,
            }); // Wrap at 72 chars
      }

      redrawText(originalMsg, generatedMsg); // replace streaming prompt with wrapped version
      quickPrint('');

      if (shouldNoCommit) {
         if (shouldYes) {
            Logger.warn('Ignoring --yes because --no-commit was requested.', 'commit');
         }
         if (shouldCopy) {
            const copied = await copyToClipboard(generatedMsg);
            if (copied) quickPrint(`${SGR.cyan}(message has been copied to clipboard)${SGR.reset}`);
            else Logger.warn('(failed to copy to clipboard)', 'commit');
         }
         return 0;
      }

      if (shouldYes) {
         const messageParts = generatedMsg.split(/\n{2,}/).filter((part) => part.trim().length > 0);
         const commitArgs: string[] = [];
         for (const part of messageParts) {
            commitArgs.push('-m', part);
         }

         await $inherit`${git$} commit ${commitArgs} ${passThruArgs}`.catch(noop);
         return 0;
      }

      // Write to temp file and commit
      const tempFile = path.join(TEMP_DIR, `gdx_commit_msg_${Date.now()}.txt`);
      await fs.writeFile(tempFile, generatedMsg, 'utf8');

      await $inherit`${git$} commit -F ${tempFile} --edit ${passThruArgs}`.catch(noop);

      await fs.unlink(tempFile).catch(noop);
      return 0;
   } catch (err) {
      Logger.error(yuString(err, { color: true }), 'commit');
      return 1;
   }
}

export default {
   auto: autoCommit,
};

export const help = {
   long: () => {
      return strWrap(
         litedent`
         ${SGR.bright + _2PointGradient('COMMIT AUTO', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         Generate a commit message from staged changes using an LLM.

         ${SGR.bright + _2PointGradient('DESCRIPTION', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         Analyze the staged diff and ask the configured LLM provider to produce a well-formed commit message (title and body). The generated text is streamed for interactive feedback; you may choose to commit it automatically or inspect/copy it first.

         ${SGR.bright + _2PointGradient('FLAGS AND BEHAVIOR', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         Use ${SGR.cyan}--no-commit (-nc)${SGR.reset} to prevent creating the commit (message will be printed). Use ${SGR.cyan}--copy (-cp)${SGR.reset} in combination with --no-commit to copy the message to the clipboard. Use ${SGR.cyan}--yes (-y)${SGR.reset} to commit immediately without writing a temporary message file or opening an editor (ignored when --no-commit is set). Use ${SGR.cyan}--describe (-d) <text>${SGR.reset} to provide a short human summary of the change intent so the model can prioritize relevant diff sections. Use ${SGR.cyan}--preview${SGR.reset} to print the complete generated prompt and exit (no LLM request, no commit). The tool writes a temporary message file when performing an interactive commit.

         ${SGR.bright + _2PointGradient('REQUIREMENTS', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         A non-empty staged diff is required; the command will error if there are no staged changes.
         `,
         Math.min(100, global.terminalWidth - 4),
         {
            firstIndent: '  ',
            mode: 'softboundary',
            indent: '  ',
         }
      );
   },
   short: 'Extends git commit with ability to auto-generate messages using an LLM.',
   usage: () => {
      return strWrap(
         litedent`
         ${SGR.cyan}${EXECUTABLE_NAME} commit auto ${SGR.dim}[--no-commit|-nc] [--copy|-cp] [--yes|-y] [--describe|-d <text>] [--preview]${SGR.reset}

         Examples:
            ${SGR.cyan}${EXECUTABLE_NAME} commit auto                    ${SGR.reset + SGR.dim}# Generate and commit using LLM-generated message${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} commit auto --no-commit        ${SGR.reset + SGR.dim}# Print generated message without committing${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} commit auto --no-commit --copy ${SGR.reset + SGR.dim}# Copy generated message to clipboard${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} commit auto --yes              ${SGR.reset + SGR.dim}# Commit immediately without editing${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} commit auto -d ${'"refactor parser + trim noisy lockfile diffs"'} ${SGR.reset + SGR.dim}# Add extra context for the LLM${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} commit auto --preview          ${SGR.reset + SGR.dim}# Print full LLM prompt and exit${SGR.reset}`,
         Math.min(100, global.terminalWidth - 4),
         {
            firstIndent: '  ',
            mode: 'softboundary',
            indent: '  ',
         }
      );
   },
};
