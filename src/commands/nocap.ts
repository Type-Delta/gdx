import { ncc, yuString } from '@lib/Tools';

import { GdxContext } from '../common/types';
import { $, spinner } from '../utils/shell';
import { quickPrint } from '../utils/utilities';
import { getLLMProvider } from '../common/adapters/llm';
import { nocapPrompt } from '../templates/prompts';
import { COLOR } from '@/consts';

export default async function nocap(ctx: GdxContext): Promise<number> {
   const { git$ } = ctx;

   try {
      const authorMail = (await $`${git$} config user.email`).stdout.trim();

      // Get latest commit message from this author
      const latestCommitMessage = (await $`${git$} log -1 --pretty=format:%s\n\n%b --author=${authorMail} --no-merges`).stdout.trim();

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
         gradientColorBg: COLOR.Fuchsia700
      });

      const connection = llm.streamGenerate({
         prompt: nocapPrompt(latestCommitMessage),
         temperature: 0.8,
         maxTokens: 269,
         reasoning: 'low'
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
      quickPrint(`${ncc('Red')}Error: ${err}${ncc()}`);
      return 1;
   }
}
