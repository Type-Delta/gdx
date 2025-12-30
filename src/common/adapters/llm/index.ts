import { Err } from '@lib/Tools';

import { OPENROUTER_API_BASE } from '@/consts';
import { getConfig } from '../../config';
import { OpenAIAdapter } from './openai';
import { LLMProvider } from './types';
import { MockLLMAdapter } from './mock';

export async function getLLMProvider(): Promise<LLMProvider> {
   if (process.env.NODE_ENV === 'test') {
      return new MockLLMAdapter();
   }

   const config = await getConfig();

   let providerType = config.get<string>('llm.provider') || 'openai';
   const apiKey = await config.getSecure<string>('llm.apiKey');
   const model = config.get<string>('llm.model');

   if (!apiKey) {
      throw new Err(
         'No API key found. Please set llm.apiKey in ~/.gdxrc.toml or GDX_LLM_API_KEY env var.',
         'NO_API_KEY'
      );
   }

   if (apiKey.startsWith('sk-or-')) {
      providerType = 'openrouter';
   }

   switch (providerType.toLowerCase()) {
      case 'openrouter':
         return new OpenAIAdapter(apiKey, OPENROUTER_API_BASE, model);
      case 'openai':
         return new OpenAIAdapter(apiKey, undefined, model);
      default:
         throw new Err(`Unsupported LLM provider: ${providerType}`, 'UNSUPPORTED_LLM_PROVIDER');
   }
}

export * from './types';
