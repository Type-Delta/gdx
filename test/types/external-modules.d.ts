declare module '@babel/core' {
   export function transformAsync(
      code: string,
      options: Record<string, unknown>
   ): Promise<{ code?: string } | null>;
}

declare module '*.mjs' {
   export const transformToolsToTreeShakeable: (api: unknown) => unknown;
}
