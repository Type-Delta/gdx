export interface LLMRequest {
   prompt: string;
   temperature?: number;
   maxTokens?: number;
   model?: string;
}

export interface LLMProvider {
   generate(request: LLMRequest): Promise<string>;
}
