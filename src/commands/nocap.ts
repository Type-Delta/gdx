import dedent from 'dedent';
import { ncc, yuString } from '@lib/Tools';

import { GdxContext } from '../common/types';
import { $, spinner } from '../utils/shell';
import { quickPrint } from '../utils/utilities';
import { getLLMProvider } from '../common/adapters/llm';
import { nocapPrompt } from '../templates/prompts';
import { COLOR, EXECUTABLE_NAME } from '@/consts';

export default async function nocap(ctx: GdxContext): Promise<number> {
   const { git$ } = ctx;

   try {
      const authorMail = (await $`${git$} config user.email`).stdout.trim();

      // Get latest commit message from this author
      const latestCommitMessage = (
         await $`${git$} log -1 --pretty=format:%s\n\n%b --author=${authorMail} --no-merges`.catch(
            () => {}
         )
      )?.stdout.trim();

      if (!latestCommitMessage || latestCommitMessage.length === 0) {
         quickPrint(`${ncc('Red')}Bro, you haven't committed anything yet. 🤣${ncc()}`);
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
            quickPrint(
               `${ncc('Red')}😭 ill bro, the server rejected u${ncc()}\n\n` +
                  yuString(response.error, { color: true })
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
         quickPrint(`${ncc('Red')}Error: Unable to generate response (empty response).${ncc()}`);
         return 1;
      }

      return 0;
   } catch (err) {
      quickPrint(yuString(err, { color: true }));
      return 1;
   }
}

export const help = {
   long: dedent(`${ncc('Cyan')}nocap - Generate a playful roast for your latest commit message${ncc()}

      ${ncc('Bright')}What it does:${ncc()} Reads the latest commit message authored by the configured git user
      and asks the configured LLM provider to produce a humorous "roast" or light-hearted commentary. Output is
      streamed to the terminal with progress spinners and incremental printing as the LLM responds.

      ${ncc('Bright')}When to use:${ncc()} Use when you want a quick, entertaining summary/critique of your most
      recent commit message before pushing, or as a lighthearted CI/gaming aid.

      ${ncc('Bright')}Notes:${ncc()} The command requires a valid git user.email in repo config and a configured LLM
      adapter. Network or LLM errors will print a colored error and return a non-zero exit code.
   `),
   short: 'Create a humorous critique of your latest commit message.',
   usage: dedent(`
      ${EXECUTABLE_NAME} nocap

      Examples:
        ${EXECUTABLE_NAME} nocap                     # Roast the latest commit by the configured git user
   `),
};
