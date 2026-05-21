import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const GENERIC_WORKER_FILE_NAME = 'generic.worker.min.js';

let genericWorkerUrl: URL | null | undefined;

/**
 * Resolves the generic worker module for source, packaged Node, and native sidecar runtimes.
 * @returns URL to the generic worker, or null when no worker file is available.
 */
export function getGenericWorkerUrl(): URL | null {
   if (genericWorkerUrl !== undefined) return genericWorkerUrl;

   /**
    * FIXME: There is an issue where bun would hang when after loading Workers from a file URL in a compiled executable. This seems to be a bun runtime issue and needs further investigation.
    * For now we just disable the worker in this specific environment and fall back to single-threaded mode, which is still better than hanging.
    *
    * (removing this gate will cause bun compiled executables to use workers)
    */
   if (isCompiledBunRuntime()) {
      genericWorkerUrl = null;
      return genericWorkerUrl;
   }

   if (import.meta.url.endsWith('/dist/index.js')) {
      genericWorkerUrl = new URL(`./workers/${GENERIC_WORKER_FILE_NAME}`, import.meta.url);
      return genericWorkerUrl;
   }

   if (import.meta.url.includes('/src/cli/')) {
      genericWorkerUrl = new URL('../workers/generic.worker.ts', import.meta.url);
      return genericWorkerUrl;
   }

   const executableWorkerPath = path.join(
      path.dirname(process.execPath),
      'workers',
      GENERIC_WORKER_FILE_NAME
   );
   if (existsSync(executableWorkerPath)) {
      genericWorkerUrl = pathToFileURL(executableWorkerPath);
      return genericWorkerUrl;
   }

   genericWorkerUrl = null;
   return genericWorkerUrl;
}

/**
 * Returns true inside a Bun-compiled executable.
 */
function isCompiledBunRuntime(): boolean {
   return Boolean(process.versions.bun) && !/[\\/]bun(?:\.exe)?$/i.test(process.execPath);
}
