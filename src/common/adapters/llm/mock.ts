/* eslint-disable @typescript-eslint/no-unused-vars */
import { asyncSleep } from '@lib/Tools';
import { LLMProvider, LLMRequest, StreamChunk } from './types';

interface MockLLMAdapterConfig {
   /**
    * Optional delay in milliseconds before each chunk is yielded, to simulate network latency or processing time. Default is 0 (no delay).
    */
   responseDelayMs?: number;
   /**
    * Optional delay in milliseconds before yielding each thinking chunk, to simulate the time taken for the model to "think" before producing output. Default is 0 (no delay).
    */
   streamDelayMs?: number;
}

export class MockLLMAdapter implements LLMProvider {
   constructor(private config: MockLLMAdapterConfig = {}) {
      this.config = {
         responseDelayMs: 0,
         streamDelayMs: 0,
         ...config,
      };
   }

   async generate(request: LLMRequest): Promise<string> {
      return `Mock response from LLM`;
   }

   async *streamGenerate(request: LLMRequest): AsyncGenerator<StreamChunk> {
      const prompt = `Mock response from LLM`;
      const words = prompt.split(' ');

      if (this.config.responseDelayMs! > 0)
         await asyncSleep(this.config.responseDelayMs!);

      const thinking =
         `I should generate a mock response for prompt with ${words.length} words.`.split(' ');
      for (const thought of thinking) {
         if (this.config.streamDelayMs! > 0)
            await asyncSleep(this.config.streamDelayMs!);

         yield {
            chunk: undefined,
            thinkingChunk: thought + ' ',
            metadata: {},
         };
      }

      for (const word of words) {
         if (this.config.streamDelayMs! > 0)
            await asyncSleep(this.config.streamDelayMs!);

         yield {
            chunk: word + ' ',
            thinkingChunk: undefined,
            metadata: {},
         };
      }
   }
}

export * from './types';
