import * as fs from '@/modules/fs';
import path from 'path';
import crypto from 'crypto';

import { ncc, strWrap, yuString } from '@lib/Tools';

import { GdxContext } from '@/common/types';
import { $, $inherit, copyToClipboard, spinner } from '@/modules/shell';
import { noop, quickPrint } from '@/utils/utilities';
import { getLLMProvider } from '@/common/adapters/llm';
import Logger from '@/utils/logger';
import {
   commitMsgGenerator,
   commitMsgGeneratorInherent,
   guidelineLearningPrompt,
} from '@/templates/prompts';
import { EXECUTABLE_NAME, TEMP_DIR, GDX_VPALETTE } from '@/consts';
import { _2PointGradient } from '@/modules/graphics';
import global from '@/global';
import { getConfig } from '@/common/config';
import { getCache } from '@/common/cache';
import { getMainWorktreeRoot, getNormalizedRemoteUrl } from '@/modules/git';

/**
 * Generates a hash for the given value.
 */
function createHash(value: string): string {
   return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/**
 * Learns commit message guidelines from repository history.
 * Returns the guideline text or null if learning failed/not enough history.
 */
async function learnCommitGuidelines(
   git$: string | string[]
): Promise<{ guideline: string | null; historyCount: number }> {
   quickPrint('');

   const spin = spinner({
      message: "learning this repo's commit style...",
      animateGradient: true,
   });

   try {
      // Fetch recent commit messages (full body)
      const result = await $`${git$} log --no-merges -n 10 --format=%B%x00`;
      const commitMessages = result.stdout
         .split('\x00')
         .map((msg) => msg.trim())
         .filter((msg) => msg.length > 0);

      if (commitMessages.length === 0) {
         spin.stop();
         return { guideline: null, historyCount: 0 };
      }

      // Take 5-10 messages
      const samplesToUse = commitMessages.slice(0, Math.min(10, commitMessages.length));

      // Ask LLM to learn the pattern
      const llm = await getLLMProvider();
      const guideline = await llm.generate({
         prompt: guidelineLearningPrompt(samplesToUse),
         temperature: 0.2,
         reasoning: 'medium',
      });

      spin.stop();
      return { guideline: guideline.trim(), historyCount: samplesToUse.length };
   } catch (err) {
      spin.stop();
      Logger.warn(`Failed to learn commit guidelines: ${yuString(err)}`, 'commit');
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
   const normalizedRepoRoot = mainRepoRoot.replace(/\\/g, '/');
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

   // Filter out gdx-specific flags to get pass-through args
   const gdxFlags = ['auto', '--no-commit', '-nc', '--copy', '-cp', '--yes', '-y'];
   const passThruArgs = args.slice(1).filter((arg) => !gdxFlags.includes(arg));
   const config = await getConfig();
   const showThinking = config.get<boolean>('llm.showThinking', true);
   const commitPattern = config.get<'inherit' | 'comprehensive'>('commit.commitPattern', 'inherit');

   const cachedChanges = (await $`${git$} diff --cached HEAD`).stdout;

   if (!cachedChanges || cachedChanges.trim().length === 0) {
      quickPrint(
         `${ncc('Red')}No staged changes found. Please stage your changes before generating a commit message.${ncc()}`
      );
      return 1;
   }

   // Determine which prompt to use based on pattern setting
   let prompt: string;
   if (commitPattern === 'inherit') {
      const guidelines = await getCommitGuidelines(git$, config);
      if (guidelines) {
         prompt = commitMsgGeneratorInherent(cachedChanges, guidelines);
      } else {
         // Fallback to comprehensive if learning failed
         prompt = commitMsgGenerator(cachedChanges);
      }
   } else {
      prompt = commitMsgGenerator(cachedChanges);
   }

   quickPrint(`${ncc('Cyan')}Generating commit message based on staged changes...${ncc()}\n`);

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
            Logger.error(response.error.message, 'commit');
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
               quickPrint(`${ncc('Cyan')}Generated Commit Message:${ncc()}`);
            }
            quickPrint(response.chunk, '');
            generatedMsg += response.chunk;
         }
      }

      quickPrint('\n'); // 2 Final newline after message output

      if (!generatedMsg) {
         Logger.error('Unable to generate commit message (empty response).', 'commit');
         return 1;
      }

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

      const shouldNoCommit = args.includes('--no-commit') || args.includes('-nc');
      const shouldYes = args.includes('--yes') || args.includes('-y');

      if (shouldNoCommit) {
         if (shouldYes) {
            Logger.warn('Ignoring --yes because --no-commit was requested.', 'commit');
         }
         if (args.includes('--copy') || args.includes('-cp')) {
            const copied = await copyToClipboard(generatedMsg);
            if (copied) quickPrint(`${ncc('Cyan')}(message has been copied to clipboard)${ncc()}`);
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
      const bright = ncc('Bright');
      const cyan = ncc('Cyan');
      const reset = ncc();
      return strWrap(
         `
${bright + _2PointGradient('COMMIT AUTO', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
Generate a commit message from staged changes using an LLM.

${bright + _2PointGradient('DESCRIPTION', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
Analyze the staged diff and ask the configured LLM provider to produce a well-formed commit message (title and body). The generated text is streamed for interactive feedback; you may choose to commit it automatically or inspect/copy it first.

${bright + _2PointGradient('FLAGS AND BEHAVIOR', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
 Use ${cyan}--no-commit (-nc)${reset} to prevent creating the commit (message will be printed). Use ${cyan}--copy (-cp)${reset} in combination with --no-commit to copy the message to the clipboard. Use ${cyan}--yes (-y)${reset} to commit immediately without writing a temporary message file or opening an editor (ignored when --no-commit is set). The tool writes a temporary message file when performing an interactive commit.

${bright + _2PointGradient('REQUIREMENTS', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
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
   short: 'Auto-generate a commit message from staged changes using an LLM.',
   usage: () => {
      const cyan = ncc('Cyan');
      const dim = ncc('Dim');
      const reset = ncc();
      return strWrap(
         `
 ${cyan}${EXECUTABLE_NAME} commit auto ${dim}[--no-commit|-nc] [--copy|-cp] [--yes|-y]${reset}

Examples:
   ${cyan}${EXECUTABLE_NAME} commit auto                    ${reset + dim}# Generate and commit using LLM-generated message${reset}
    ${cyan}${EXECUTABLE_NAME} commit auto --no-commit        ${reset + dim}# Print generated message without committing${reset}
    ${cyan}${EXECUTABLE_NAME} commit auto --no-commit --copy ${reset + dim}# Copy generated message to clipboard${reset}
    ${cyan}${EXECUTABLE_NAME} commit auto --yes              ${reset + dim}# Commit immediately without editing${reset}`,
         Math.min(100, global.terminalWidth - 4),
         {
            firstIndent: '  ',
            mode: 'softboundary',
            indent: '  ',
         }
      );
   },
};
