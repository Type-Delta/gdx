import OpenAI from 'openai';
import { LLMProvider, LLMRequest, OpenAICouldHaveReasoningChunk, StreamChunk } from './types';
import fs from 'fs';

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
         reasoning_effort: request.reasoning,
      });

      return completion.choices[0].message.content || '';
   }

   async *streamGenerate(request: LLMRequest): AsyncGenerator<StreamChunk> {
      try {
         const stream = await this.client.chat.completions.create({
            messages: [
               { role: 'user', content: request.prompt }
            ],
            model: request.model || this.defaultModel,
            temperature: request.temperature,
            max_tokens: request.maxTokens,
            stream: true,
            reasoning_effort: request.reasoning,
         });

         for await (const chunk of stream) {
            // TODO: Remove me!
            // fs.appendFileSync('debug_openai_stream.json', JSON.stringify(chunk, null, 2) + '\n', { encoding: 'utf-8' }); // Debugging line
            const delta = chunk.choices[0]?.delta as (OpenAICouldHaveReasoningChunk & typeof chunk.choices[number]['delta']);
            const content = delta?.content;
            const thinking = delta?.reasoning_content || delta?.reasoning || delta?.reasoning_details?.[0]?.summary;

            if (content || thinking) {
               yield {
                  chunk: content ?? undefined,
                  thinkingChunk: thinking ?? undefined,
                  metadata: {
                     model: chunk.model,
                     finishReason: chunk.choices[0]?.finish_reason ?? undefined,
                  }
               };
            }
         }
      } catch (error) {
         yield {
            error: error instanceof Error ? error : new Error(String(error))
         };
      }
   }
}
