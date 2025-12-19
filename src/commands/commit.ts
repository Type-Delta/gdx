import fs from 'fs/promises';
import path from 'path';
import os from 'os';

import { ncc, strWrap, yuString } from '@lib/Tools';

import { GdxContext } from '../common/types';
import { $, $inherit, copyToClipboard, spinner } from '../utils/shell';
import { quickPrint } from '../utils/utilities';
import { getLLMProvider } from '../common/adapters/llm';
import { commitMsgGenerator } from '../templates/prompts';

async function autoCommit(ctx: GdxContext): Promise<number> {
   const { git$, args } = ctx;

   // Filter out gdx-specific flags to get pass-through args
   const gdxFlags = ['auto', '--no-commit', '-nc', '--copy', '-cp'];
   const passThruArgs = args.slice(1).filter(arg => !gdxFlags.includes(arg));

   const cachedChanges = (await $`${git$} diff --cached HEAD`).stdout;

   if (!cachedChanges || cachedChanges.trim().length === 0) {
      quickPrint(`${ncc('Red')}No staged changes found. Please stage your changes before generating a commit message.${ncc()}`);
      return 1;
   }

   quickPrint(`${ncc('Cyan')}Generating commit message based on staged changes...${ncc()}\n`);

   try {
      const llm = await getLLMProvider();

      const spin = spinner({
         message: 'connecting...',
         animateGradient: false
      });

      const connection = llm.streamGenerate({
         prompt: commitMsgGenerator(cachedChanges),
         temperature: 0.14,
         reasoning: 'low'
      });

      let res = '';
      let hasReceivedContent = false;
      let isReasoning = false;

      for await (const response of connection) {
         if (response.error) {
            spin.stop();
            quickPrint(`${ncc('Red')}Error: ${response.error.message}${ncc()}`);
            return 1;
         }

         if (response.thinkingChunk) {
            if (!isReasoning) {
               isReasoning = true;
               spin.options.message = 'reasoning...';
               spin.options.animateGradient = true;
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
            res += response.chunk;
         }
      }

      quickPrint('\n'); // 2 Final newline after message output

      if (!res) {
         quickPrint(`${ncc('Red')}Error: Unable to generate commit message (empty response).${ncc()}`);
         return 1;
      }

      res = res.replace(/(^\s*["'`]*|["'`]*\s*$)/g, ''); // Remove surrounding quotes if any
      res = strWrap(res, 72, {
         mode: 'softboundery',
         redundancyLv: -1
      }); // Wrap at 72 chars

      if (args.includes('--no-commit') || args.includes('-nc')) {
         if (args.includes('--copy') || args.includes('-cp')) {
            const copied = await copyToClipboard(res);
            if (copied)
               quickPrint(`${ncc('Cyan')}(message has been copied to clipboard)${ncc()}`);
            else
               quickPrint(`${ncc('Yellow')}(failed to copy to clipboard)${ncc()}`);
         }
         return 0;
      }

      // Write to temp file and commit
      const tempFile = path.join(os.tmpdir(), `gdx_commit_msg_${Date.now()}.txt`);
      await fs.writeFile(tempFile, res, 'utf8');

      await $inherit`${git$} commit -F ${tempFile} --edit ${passThruArgs}`;

      await fs.unlink(tempFile).catch(() => { });
      return 0;

   } catch (err) {
      quickPrint(yuString(err, { color: true }));
      return 1;
   }
}


export default {
   auto: autoCommit
}
