import { describe, expect, it } from 'bun:test';

import { OpenAIAdapter } from '@/common/adapters/llm/openai';

describe('OpenAIAdapter', () => {
   it('should reject generate before the client is initialized', async () => {
      const adapter = new OpenAIAdapter('test-key');

      await expect(adapter.generate({ prompt: 'hello' })).rejects.toThrow(
         'OpenAI client not initialized'
      );
   });

   it('should convert streamed content and reasoning deltas into StreamChunk values', async () => {
      const adapter = new OpenAIAdapter('test-key');
      const fakeStream = [
         {
            model: 'test-model',
            choices: [{ delta: { reasoning: 'thinking' }, finish_reason: null }],
         },
         {
            model: 'test-model',
            choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }],
         },
      ];

      Object.assign(adapter, {
         client: {
            chat: {
               completions: {
                  create: async () => fakeStream,
               },
            },
         },
      });

      const chunks = [];
      for await (const chunk of adapter.streamGenerate({ prompt: 'hello', reasoning: 'low' })) {
         chunks.push(chunk);
      }

      expect(chunks).toEqual([
         {
            thinkingChunk: 'thinking',
            chunk: undefined,
            metadata: { model: 'test-model', finishReason: undefined },
         },
         {
            chunk: 'answer',
            thinkingChunk: undefined,
            metadata: { model: 'test-model', finishReason: 'stop' },
         },
      ]);
   });

   it('should yield stream errors instead of throwing them', async () => {
      const adapter = new OpenAIAdapter('test-key');
      Object.assign(adapter, {
         client: {
            chat: {
               completions: {
                  create: async () => {
                     throw new Error('upstream failed');
                  },
               },
            },
         },
      });

      const chunks = [];
      for await (const chunk of adapter.streamGenerate({ prompt: 'hello' })) {
         chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0].error?.message).toBe('upstream failed');
   });
});
