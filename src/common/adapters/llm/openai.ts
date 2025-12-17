import OpenAI from 'openai';
import { LLMProvider, LLMRequest } from './types';

export class OpenAIAdapter implements LLMProvider {
   private client: OpenAI;
   private defaultModel: string;

   constructor(apiKey: string, baseURL?: string, defaultModel: string = 'gpt-4o') {
      this.client = new OpenAI({
         apiKey,
         baseURL,
      });
      this.defaultModel = defaultModel;
   }

   async generate(request: LLMRequest): Promise<string> {
      const completion = await this.client.chat.completions.create({
         messages: [
            { role: 'user', content: request.prompt }
         ],
         model: request.model || this.defaultModel,
         temperature: request.temperature,
         max_tokens: request.maxTokens,
      });

      return completion.choices[0].message.content || '';
   }
}
