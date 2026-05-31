import { Err } from '@lib/Tools';

import { OPENROUTER_API_BASE } from '@/consts';
import { getConfig } from '../../config';
import { OpenAIAdapter } from './openai';
import { LLMProvider } from './types';

export async function getLLMProvider(): Promise<LLMProvider> {
   const config = await getConfig();
   let providerType = config.get<string>('llm.provider') || 'openai';

   const apiKey = await config.getSecure<string>('llm.apiKey');
   const model = config.get<string>('llm.model');

   if (!apiKey) {
      throw new Err(
         'No API key found. Please set llm.apiKey with gdx-config command or GDX_LLM_API_KEY env var.',
         'NO_API_KEY'
      );
   }

   if (apiKey.startsWith('sk-or-')) {
      providerType = 'openrouter';
   }

   switch (providerType.toLowerCase()) {
      case 'openrouter': {
         const adapter = new OpenAIAdapter(apiKey, OPENROUTER_API_BASE, model, {
            'HTTP-Referer': 'https://github.com/Type-Delta/gdx/tree/main',
            'X-Title': 'GDX',
         });
         await adapter.initClient();
         return adapter;
      }
      case 'openai': {
         const adapter = new OpenAIAdapter(apiKey, undefined, model);
         await adapter.initClient();
         return adapter;
      }
      default:
         throw new Err(`Unsupported LLM provider: ${providerType}`, 'UNSUPPORTED_LLM_PROVIDER');
   }
}

export * from './types';
