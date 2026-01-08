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

export default async function nocap(ctx: GdxContext): Promise<number> {
   const { git$ } = ctx;

   try {
      const authorMail = (await $`${git$} config user.email`).stdout.trim();

      // Get latest commit message from this author
      const latestCommitMessage = (
         await $`${git$} log -1 --pretty=format:%s\n\n%b --author=${authorMail} --no-merges`.catch(
            noop
         )
      )?.stdout.trim();

      if (!latestCommitMessage || latestCommitMessage.length === 0) {
         Logger.error('Bro, you haven\'t committed anything yet. 🤣', 'nocap');
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
            Logger.error(`😭 ill bro, the server rejected u\n\n${yuString(response.error, { color: true })}`, 'nocap');
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
   long: () =>
      strWrap(
         `
${ncc('Bright') + _2PointGradient('NOCAP', COLOR.Zinc400, COLOR.Zinc100, 0.2)}
Generate a playful roast for your latest commit message.

${ncc('Bright') + _2PointGradient('DESCRIPTION', COLOR.Zinc400, COLOR.Zinc100, 0.2)}
Reads the latest commit message authored by the configured git user and asks the configured LLM provider to produce a humorous "roast" or light-hearted commentary. Output is streamed to the terminal with progress spinners and incremental printing as the LLM responds.

${ncc('Bright') + _2PointGradient('WHEN TO USE', COLOR.Zinc400, COLOR.Zinc100, 0.2)}
Use when you want a quick, entertaining summary/critique of your most recent commit message before pushing, or as a lighthearted CI/gaming aid.

${ncc('Bright') + _2PointGradient('NOTES', COLOR.Zinc400, COLOR.Zinc100, 0.2)}
The command requires a valid git user.email in repo config and a configured LLM adapter. Network or LLM errors will print a colored error and return a non-zero exit code.
`,
         Math.min(100, global.terminalWidth - 4),
         {
            firstIndent: '  ',
            mode: 'softboundery',
            indent: '  ',
         }
      ),
   short: 'Create a humorous critique of your latest commit message.',
   usage: () =>
      strWrap(
         `
${ncc('Cyan')}${EXECUTABLE_NAME} nocap${ncc()}

Examples:
   ${ncc('Cyan')}${EXECUTABLE_NAME} nocap ${ncc() + ncc('Dim')}# Roast the latest commit by the configured git user${ncc()}`,
         Math.min(100, global.terminalWidth - 4),
         {
            firstIndent: '  ',
            mode: 'softboundery',
            indent: '  ',
         }
      ),
} as const satisfies CommandHelpObj;

export const structure = {
   $root: [],
} as const satisfies CommandStructure;
