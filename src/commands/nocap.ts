import { ncc, strWrap, yuString } from '@lib/Tools';

import { CommandHelpObj, CommandStructure, GdxContext } from '../common/types';
import { $, spinner } from '../modules/shell';
import { noop, quickPrint } from '../utils/utilities';
import { getLLMProvider } from '../common/adapters/llm';
import Logger from '../utils/logger';
import { nocapPrompt } from '../templates/prompts';
import { COLOR, EXECUTABLE_NAME } from '@/consts';
import global from '@/global';
import { _2PointGradient } from '@/modules/graphics';
import { getGitConfigCached } from '@/modules/cache-controller';

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

      // Display the commit message
      const lines = latestCommitMessage.split('\n');
      for (const line of lines) {
         quickPrint(`${ncc('Dim')}> ${ncc()}${line}`);
      }
      quickPrint(`\n${ncc('Cyan')}${ncc('Dim')}Reviewing your commit message...${ncc()}\n`);

      // Get LLM provider and generate roast
      const llm = await getLLMProvider();

      const spin = spinner({
         message: 'cooking up a roast...',
         animateGradient: true,
         gradientColor: COLOR.Teal300,
         gradientColorBg: COLOR.Fuchsia400,
      });

      const connection = llm.streamGenerate({
         prompt: nocapPrompt(latestCommitMessage),
         temperature: 0.8,
         maxTokens: 269,
         reasoning: 'low',
      });

      let res = '';
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
            res += response.chunk;
         }
      }

      quickPrint('\n');

      if (!res) {
         Logger.error('Unable to generate response (empty response).', 'nocap');
         return 1;
      }

      return 0;
   } catch (err) {
      Logger.error(yuString(err, { color: true }), 'nocap');
      return 1;
   }
}

export const help = {
   long: () => {
      const bright = ncc('Bright');
      const reset = ncc();
      return strWrap(
         `
${bright + _2PointGradient('NOCAP', COLOR.Zinc400, COLOR.Zinc100, 0.2) + reset}
Generate a playful roast for your latest commit message.

${bright + _2PointGradient('DESCRIPTION', COLOR.Zinc400, COLOR.Zinc100, 0.2) + reset}
Reads the latest commit message authored by the configured git user and asks the configured LLM provider to produce a humorous "roast" or light-hearted commentary. Output is streamed to the terminal with progress spinners and incremental printing as the LLM responds.

${bright + _2PointGradient('WHEN TO USE', COLOR.Zinc400, COLOR.Zinc100, 0.2) + reset}
Use when you want a quick, entertaining summary/critique of your most recent commit message before pushing, or as a lighthearted CI/gaming aid.

${bright + _2PointGradient('NOTES', COLOR.Zinc400, COLOR.Zinc100, 0.2) + reset}
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
      const cyan = ncc('Cyan');
      const dim = ncc('Dim');
      const reset = ncc();
      return strWrap(
         `
${cyan}${EXECUTABLE_NAME} nocap${reset}

Examples:
   ${cyan}${EXECUTABLE_NAME} nocap ${reset + dim}# Roast the latest commit by the configured git user${reset}`,
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
