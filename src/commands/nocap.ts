import litedent from 'litedent';

import { strWrap, yuString } from '@lib/Tools';

import { CommandHelpObj, CommandStructure, GdxContext } from '@/common/types';
import { $, redrawText, spinner } from '@/modules/shell';
import { noop, quickPrint } from '@/utils/utilities';
import { getLLMProvider } from '@/common/adapters/llm';
import Logger from '@/utils/logger';
import { nocapPrompt } from '@/templates/prompts';
import { GDX_VPALETTE, EXECUTABLE_NAME, SGR } from '@/consts';
import global from '@/global';
import { _2PointGradient } from '@/modules/graphics';
import { getGitConfigCached } from '@/modules/git';
import { redactSensitiveContent } from '@/utils/redact';

export default async function nocap(ctx: GdxContext): Promise<number> {
   const { git$ } = ctx;

   try {
      const authorMail = await getGitConfigCached(git$, 'user.email');

      // Get latest commit message from this author
      const latestCommitMessage = (
         await $`${git$} log -1 --pretty=format:%s\n\n%b --author=${authorMail} --no-merges`.catch(
            noop
         )
      )?.stdout.trim();

      if (!latestCommitMessage || latestCommitMessage.length === 0) {
         Logger.error("Bro, you haven't committed anything yet. 🤣", 'nocap');
         return 1;
      }

      const redactedLatestCommitMessage = redactSensitiveContent(latestCommitMessage);
      if (redactedLatestCommitMessage.redactionCount > 0) {
         Logger.warn(
            `Redacted ${redactedLatestCommitMessage.redactionCount} sensitive-looking value(s) before sending the latest commit message to the configured LLM provider.`,
            'nocap'
         );
      }

      // Display the commit message
      const lines = latestCommitMessage.split('\n');
      for (const line of lines) {
         quickPrint(`${SGR.dim}▐  ${SGR.reset}${line}`);
      }
      quickPrint(`\n${SGR.cyan}${SGR.dim}Reviewing your commit message...${SGR.reset}\n`);

      // Get LLM provider and generate roast
      const llm = await getLLMProvider();

      const spin = spinner({
         message: 'cooking up a roast...',
         animateGradient: true,
         gradientColor: GDX_VPALETTE.Teal300,
         gradientColorBg: GDX_VPALETTE.Fuchsia400,
      });

      const connection = llm.streamGenerate({
         prompt: nocapPrompt(redactedLatestCommitMessage.text),
         temperature: 0.8,
         maxTokens: 269,
         reasoning: 'low',
      });

      let generatedMsg = '';
      let hasReceivedContent = false;

      for await (const response of connection) {
         if (response.error) {
            spin.stop();
            Logger.error(
               `😭 ill bro, the server rejected u\n\n${yuString(response.error, { color: true })}`,
               'nocap'
            );
            return 1;
         }

         if (response.chunk) {
            if (!hasReceivedContent) {
               hasReceivedContent = true;
               spin.stop();
            }
            quickPrint(response.chunk, '');
            generatedMsg += response.chunk;
         }
      }

      if (!generatedMsg) {
         quickPrint('\n');
         Logger.error('Unable to generate response (empty response).', 'nocap');
         return 1;
      }

      const originalMsg = generatedMsg;
      generatedMsg = generatedMsg.replace(/(^\s*["'`]*|["'`]*\s*$)/g, '');
      generatedMsg = strWrap(generatedMsg, 72, {
         mode: 'softboundary',
         redundancyLv: 2,
      });

      redrawText(originalMsg, generatedMsg); // replace streaming prompt with wrapped version
      quickPrint();

      return 0;
   } catch (err) {
      Logger.error(yuString(err, { color: true }), 'nocap');
      return 1;
   }
}

export const help = {
   long: () => {
      return strWrap(
         litedent`
         ${SGR.bright + _2PointGradient('NOCAP', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         Generate a playful roast for your latest commit message.

         ${SGR.bright + _2PointGradient('DESCRIPTION', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         Reads the latest commit message authored by the configured git user and asks the configured LLM provider to produce a humorous "roast" or light-hearted commentary. Output is streamed to the terminal with progress spinners and incremental printing as the LLM responds.

         ${SGR.bright + _2PointGradient('WHEN TO USE', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         Use when you want a quick, entertaining summary/critique of your most recent commit message before pushing, or as a lighthearted CI/gaming aid.

         ${SGR.bright + _2PointGradient('NOTES', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         The command requires a valid git user.email in repo config and a configured LLM adapter. Network or LLM errors will print a colored error and return a non-zero exit code.
         `,
         Math.min(100, global.terminalWidth - 4),
         {
            firstIndent: '  ',
            mode: 'softboundary',
            indent: '  ',
         }
      );
   },
   short: 'Create a humorous critique of your latest commit message.',
   usage: () => {
      return strWrap(
         litedent`
         ${SGR.cyan}${EXECUTABLE_NAME} nocap${SGR.reset}

         Examples:
            ${SGR.cyan}${EXECUTABLE_NAME} nocap ${SGR.reset + SGR.dim}# Roast the latest commit by the configured git user${SGR.reset}`,
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
