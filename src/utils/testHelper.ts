import fs from 'fs/promises';
import path from 'path';

import { GdxContext } from "@/common/types";
import { ArgsSet } from "./arguments";
import { getConfig } from "@/common/config";
import { $ } from "./shell";
import { _process } from './utilities';


export function createGdxContext(tempDir: string, args: string[] = []): GdxContext {
   return {
      git$: `git -C ${tempDir}`,
      args: new ArgsSet(args),
   } satisfies GdxContext;
}

export async function createTestEnv() {
   await fs.mkdir(path.join(process.cwd(), 'test/env'), { recursive: true });
   const tmpDir = await fs.mkdtemp(path.join(process.cwd(), 'test/env/'));
   const _$ = $({ cwd: tmpDir });
   const cleanup = async () => {
      try {
         console.log(`Cleaning up temp dir: ${tmpDir}`);
         await fs.rm(tmpDir, { recursive: true, force: true });
      } catch {
         console.error(`Failed to remove temp dir: ${tmpDir}`);
      }
   };

   // Initialize a git repository
   await _$`git init`;

   // Set user config
   await _$`git config user.name "Test User"`;
   await _$`git config user.email "test@example.com"`;

   const buffer = { stdout: '', stderr: '' };
   process.env.NODE_ENV = 'test';
   // @ts-expect-error function signature mismatch
   _process.stdout.write = (msg: string) => buffer.stdout += msg;
   // @ts-expect-error function signature mismatch
   _process.stderr.write = (msg: string) => buffer.stderr += msg;

   return { tmpDir, $: _$, buffer, cleanup };
}

export async function assertLlmEnvReady(): Promise<void> {
   const config = await getConfig();

   if (!config.get<string>('llm.provider')?.trim()) {
      throw new Error('LLM provider is not set in config.');
   }

   if (!config.get<string>('llm.model')?.trim()) {
      throw new Error('LLM model is not set in config.');
   }

   if (!config.get<string>('llm.apiKey')?.trim()) {
      throw new Error('LLM API key is not set in config.');
   }
}
