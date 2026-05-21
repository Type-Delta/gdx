import { parentPort, workerData } from 'node:worker_threads';

Object.assign(process.env, workerData.env);

/**
 * Converts thrown values into structured errors that can cross worker boundaries.
 * @param error - Unknown thrown value.
 * @returns Serializable error shape.
 */
function serializeError(error: unknown): { message: string; stack?: string } {
   return error instanceof Error
      ? { message: error.message, stack: error.stack }
      : { message: String(error) };
}

(async () => {
   for (const requirement of workerData.requirements) {
      if (requirement.kind === 'import') {
         (globalThis as Record<string, unknown>)[requirement.name] = await import(
            requirement.source
         );
         continue;
      }
      (globalThis as Record<string, unknown>)[requirement.name] = eval(
         '(' + requirement.source + ')'
      );
   }

   parentPort?.on('message', async (message) => {
      try {
         const task = eval('(' + message.taskSource + ')');
         const result = await task(...message.args);
         parentPort?.postMessage({ id: message.id, result });
      } catch (error) {
         parentPort?.postMessage({ id: message.id, error: serializeError(error) });
      }
   });

   parentPort?.postMessage({ type: 'ready' });
})().catch((error) => {
   parentPort?.postMessage({ type: 'ready', error: serializeError(error) });
});
