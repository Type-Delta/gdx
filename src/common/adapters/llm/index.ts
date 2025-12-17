import { getConfig } from '../../config';
import { OpenAIAdapter } from './openai';
import { LLMProvider } from './types';

export async function getLLMProvider(): Promise<LLMProvider> {
   const config = await getConfig();

   let providerType = config.get<string>('llm.provider') || 'openai';
   const apiKey = config.get<string>('llm.apiKey');
   const model = config.get<string>('llm.model') || 'gpt-4o';

   if (!apiKey) {
      throw new Error('No API key found. Please set llm.apiKey in ~/.gdxrc.toml or GDX_LLM_API_KEY env var.');
   }

   if (apiKey.startsWith('sk-or-')) {
      providerType = 'openrouter';
   }

   switch (providerType.toLowerCase()) {
      case 'openrouter':
         return new OpenAIAdapter(apiKey, 'https://openrouter.ai/api/v1', model);
      case 'openai':
         return new OpenAIAdapter(apiKey, undefined, model);
      default:
         throw new Error(`Unsupported LLM provider: ${providerType}`);
   }
}


export * from './types';
