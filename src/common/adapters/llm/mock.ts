import { asyncSleep } from '@lib/Tools';

import { LLMProvider, LLMRequest, StreamChunk } from './types';

interface TestLLMHooks {
   onGenerate?: (request: LLMRequest) => void;
   onStreamGenerate?: (request: LLMRequest) => void;
   generateResponse?: string;
   streamResponse?: string;
}

type GlobalWithTestHooks = typeof globalThis & {
   __GDX_TEST_LLM_HOOKS?: TestLLMHooks;
};

function getTestHooks(): TestLLMHooks | undefined {
   return (globalThis as GlobalWithTestHooks).__GDX_TEST_LLM_HOOKS;
}

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
      const hooks = getTestHooks();
      hooks?.onGenerate?.(request);
      return hooks?.generateResponse ?? 'Mock response from LLM';
   }

   async *streamGenerate(request: LLMRequest): AsyncGenerator<StreamChunk> {
      const hooks = getTestHooks();
      hooks?.onStreamGenerate?.(request);

      const prompt = hooks?.streamResponse ?? 'Mock response from LLM';
      const words = prompt.split(' ');

      if (this.config.responseDelayMs! > 0) await asyncSleep(this.config.responseDelayMs!);

      const thinking =
         `I should generate a mock response for prompt with ${words.length} words.`.split(' ');
      for (const thought of thinking) {
         if (this.config.streamDelayMs! > 0) await asyncSleep(this.config.streamDelayMs!);

         yield {
            chunk: undefined,
            thinkingChunk: thought + ' ',
            metadata: {},
         };
      }

      for (const word of words) {
         if (this.config.streamDelayMs! > 0) await asyncSleep(this.config.streamDelayMs!);

         yield {
            chunk: word + ' ',
            thinkingChunk: undefined,
            metadata: {},
         };
      }
   }
}

export * from './types';
