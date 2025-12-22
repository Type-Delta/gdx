export interface LLMRequest {
   prompt: string;
   temperature?: number;
   maxTokens?: number;
   model?: string;
   reasoning?: 'none' | 'low' | 'medium' | 'high';
}

export interface StreamChunk {
   chunk?: string;
   thinkingChunk?: string;
   metadata?: {
      model?: string;
      finishReason?: string;
   };
   error?: Error;
}

export interface LLMProvider {
   generate(request: LLMRequest): Promise<string>;
   streamGenerate(request: LLMRequest): AsyncGenerator<StreamChunk>;
}

export interface OpenAIReasoningDetails {
   type: 'reasoning.summary' | (string & {});
   summary: string;
   format: 'openai-responses-v1' | (string & {});
   index: number;
}

export interface OpenAICouldHaveReasoningChunk {
   reasoning_content?: string;
   reasoning?: string;
   reasoning_details?: OpenAIReasoningDetails[];
}
