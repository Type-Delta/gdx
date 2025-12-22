/* eslint-disable @typescript-eslint/no-unused-vars */
import { LLMProvider, LLMRequest, StreamChunk } from './types';

export class MockLLMAdapter implements LLMProvider {
   async generate(request: LLMRequest): Promise<string> {
      return `Mock response from LLM`;
   }

   async *streamGenerate(request: LLMRequest): AsyncGenerator<StreamChunk> {
      const prompt = `Mock response from LLM`;
      const words = prompt.split(' ');

      const thinking =
         `I should generate a mock response for prompt with ${words.length} words.`.split(' ');
      for (const thought of thinking) {
         yield {
            chunk: undefined,
            thinkingChunk: thought + ' ',
            metadata: {},
         };
      }

      for (const word of words) {
         yield {
            chunk: word + ' ',
            thinkingChunk: undefined,
            metadata: {},
         };
      }
   }
}

export * from './types';
