import os from 'os';
import type { Worker } from 'node:worker_threads';

import { Err } from '@lib/Tools';
import { Semaphore } from '@/utils/operation';

type AsyncResult<T> = T | Promise<T>;
type ThreadedTask<TArgs extends unknown[], TResult> = (...args: TArgs) => AsyncResult<TResult>;
type ThreadedMapTask<TItem, TResult> = (
   item: TItem,
   index: number,
   items: TItem[]
) => AsyncResult<TResult>;
type RequirementValue = string | ((...args: never[]) => unknown) | object;

interface ThreadedRequirement {
   kind: 'import' | 'function' | 'value';
   name: string;
   source?: string;
}

interface ThreadedWorker {
   worker: Worker;
   ready: Promise<void>;
   busy: boolean;
   terminated: boolean;
}

interface WorkerMessage<TResult> {
   id?: number;
   type?: 'ready';
   result?: TResult;
   error?: {
      message: string;
      stack?: string;
   };
}

export interface ThreadedOptions {
   /**
    * Maximum number of worker threads. Defaults to the number of CPU cores minus one to avoid saturating the system. Setting this to 1 will run all tasks sequentially in a single worker thread, while higher values will allow for concurrent execution of tasks up to the specified limit.
    */
   maxWorker?: number;
   /**
    * Optional shared semaphore for controlling concurrency across multiple Threaded instances. If provided, this semaphore will be used to limit the number of concurrently running tasks across all instances that share it. This can be useful for coordinating access to shared resources or limiting overall system load when using multiple Threaded pools in the same application.
    */
   semaphore?: Semaphore;
   /**
    * Optional timeout in milliseconds for tasks. If a task does not complete within this time, it will be considered failed and the worker will be terminated. This is a safety measure to prevent hanging workers, but should be used with caution as it can lead to unexpected terminations if set too low.
    */
   taskTimeout?: number;
}

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');

function serializeError(error) {
   return error instanceof Error
      ? { message: error.message, stack: error.stack }
      : { message: String(error) };
}

(async () => {
   for (const requirement of workerData.requirements) {
      if (requirement.kind === 'import') {
         globalThis[requirement.name] = await import(requirement.source);
         continue;
      }
      globalThis[requirement.name] = eval('(' + requirement.source + ')');
   }

   parentPort.on('message', async (message) => {
      try {
         const task = eval('(' + message.taskSource + ')');
         const result = await task(...message.args);
         parentPort.postMessage({ id: message.id, result });
      } catch (error) {
         parentPort.postMessage({ id: message.id, error: serializeError(error) });
      }
   });

   parentPort.postMessage({ type: 'ready' });
})().catch((error) => {
   parentPort.postMessage({ type: 'ready', error: serializeError(error) });
});
`;

/**
 * Runs async functions in reusable worker threads with shared scheduling limits.
 */
export class Threaded<TData = unknown> {
   private readonly requirements: ThreadedRequirement[] = [];
   private readonly maxWorker: number;
   private readonly workerSemaphore: Semaphore | null;
   private readonly taskTimeout?: number;
   private readonly workers = new Set<ThreadedWorker>();
   private readonly idleWorkers: ThreadedWorker[] = [];
   private readonly workerWaiters: Array<(worker: ThreadedWorker) => void> = [];
   private dataValue?: TData;
   private nextTaskId = 1;
   private startingWorkers = 0;
   private closed = false;

   /**
    * Creates a worker-thread task scheduler.
    * @param options - Worker concurrency and task timeout settings.
    */
   constructor(options: ThreadedOptions = {}) {
      this.maxWorker = Math.max(1, options.maxWorker ?? Math.floor(os.cpus().length / 2));
      this.taskTimeout = options.taskTimeout;
      this.workerSemaphore = options.semaphore || null;
   }

   /**
    * Exposes an import, function, or serializable value to worker tasks.
    * @param shared - Module path, function, or source-serializable object.
    * @param name - Identifier exposed on globalThis inside the worker.
    * @returns The current pool for chaining.
    */
   require(shared: RequirementValue, name: string): this {
      if (this.workers.size > 0) {
         throw new Error('Threaded.require() must be called before the pool creates workers.');
      }
      assertIdentifier(name);

      if (typeof shared === 'string') {
         this.requirements.push({ kind: 'import', name, source: shared });
         return this;
      }

      if (typeof shared === 'function') {
         this.requirements.push({ kind: 'function', name, source: shared.toString() });
         return this;
      }

      this.requirements.push({ kind: 'value', name, source: stringifyWorkerValue(shared) });
      return this;
   }

   /**
    * Sets the default data used by map.
    * @param data - Input array for a later map call.
    * @returns The current pool typed with the supplied data.
    */
   data<TNextData>(data: TNextData): Threaded<TNextData> {
      this.dataValue = data as unknown as TData;
      return this as unknown as Threaded<TNextData>;
   }

   /**
    * Runs one task in a scheduled reusable worker thread.
    * @param task - Function to execute in the worker.
    * @param args - Arguments passed to the task.
    * @returns The worker task result.
    */
   async spawn<TResult, TArgs extends unknown[] = []>(
      task: ThreadedTask<TArgs, TResult>,
      args = [] as unknown as TArgs
   ): Promise<Awaited<TResult>> {
      if (this.closed) throw new Error('Threaded pool is closed.');

      const worker = await this.acquireWorker();
      try {
         return await this.runTask(worker, task, args);
      } finally {
         this.releaseWorker(worker);
      }
   }

   /**
    * Runs one worker task per item while respecting the pool worker limit.
    * @param task - Function to execute for each item.
    * @param data - Optional item list; defaults to the last value set by data().
    * @returns Results in the same order as the input data.
    */
   async map<TResult, TItem = TData extends Array<infer TArrayItem> ? TArrayItem : unknown>(
      task: ThreadedMapTask<TItem, TResult>,
      data?: TItem[]
   ): Promise<Array<Awaited<TResult>>> {
      const items = data ?? this.dataValue;
      if (!Array.isArray(items)) {
         throw new Error('Threaded.map() requires array data.');
      }

      const typedItems = items as TItem[];
      return await Promise.all(
         typedItems.map((item, index) => this.spawn(task, [item, index, typedItems]))
      );
   }

   /**
    * Terminates all workers owned by this pool.
    */
   async destroy(): Promise<void> {
      this.closed = true;
      const workers = [...this.workers];
      this.workers.clear();
      this.idleWorkers.length = 0;
      this.workerWaiters.length = 0;
      await Promise.all(workers.map((slot) => slot.worker.terminate()));
   }

   private async acquireWorker(): Promise<ThreadedWorker> {
      const idleWorker = this.idleWorkers.pop();
      if (idleWorker && !idleWorker.terminated) {
         idleWorker.busy = true;
         idleWorker.worker.ref();
         return idleWorker;
      }

      if (this.workers.size + this.startingWorkers < this.maxWorker) {
         this.startingWorkers++;
         try {
            const worker = await this.createWorker();
            worker.busy = true;
            worker.worker.ref();
            return worker;
         } finally {
            this.startingWorkers--;
         }
      }

      return await new Promise<ThreadedWorker>((resolve) => {
         this.workerWaiters.push((worker) => {
            worker.busy = true;
            worker.worker.ref();
            resolve(worker);
         });
      });
   }

   private releaseWorker(worker: ThreadedWorker): void {
      if (worker.terminated || !this.workers.has(worker)) return;
      worker.busy = false;

      const nextWaiter = this.workerWaiters.shift();
      if (nextWaiter) {
         nextWaiter(worker);
         return;
      }

      worker.worker.unref();
      this.idleWorkers.push(worker);
   }

   private async createWorker(): Promise<ThreadedWorker> {
      const { Worker } = await import('node:worker_threads');
      const worker = new Worker(WORKER_SOURCE, {
         eval: true,
         workerData: {
            requirements: this.requirements.map(({ kind, name, source }) => ({
               kind,
               name,
               source,
            })),
         },
      });
      const slot: ThreadedWorker = {
         worker,
         ready: Promise.resolve(),
         busy: false,
         terminated: false,
      };
      slot.ready = this.waitForReady(slot);
      this.workers.add(slot);
      worker.once('exit', () => this.removeWorker(slot));
      await slot.ready;
      worker.on('error', () => this.removeWorker(slot));
      return slot;
   }

   private async waitForReady(slot: ThreadedWorker): Promise<void> {
      await new Promise<void>((resolve, reject) => {
         const onReady = (message: WorkerMessage<unknown>): void => {
            if (message.type !== 'ready') return;
            cleanup();
            if (message.error) {
               const error = new Error(message.error.message);
               error.stack = message.error.stack;
               reject(error);
               return;
            }
            resolve();
         };
         const onError = (error: Error): void => {
            cleanup();
            reject(error);
         };
         const onExit = (code: number): void => {
            if (code === 0) return;
            cleanup();
            reject(new Error(`Threaded worker exited with code ${code}.`));
         };
         const cleanup = (): void => {
            slot.worker.off('message', onReady);
            slot.worker.off('error', onError);
            slot.worker.off('exit', onExit);
         };

         slot.worker.on('message', onReady);
         slot.worker.once('error', onError);
         slot.worker.once('exit', onExit);
      }).catch((error) => {
         this.removeWorker(slot);
         void slot.worker.terminate();
         throw new Error(`Threaded worker initialization failed: ${Err.from(error)}`);
      });
   }

   private async runTask<TResult, TArgs extends unknown[]>(
      slot: ThreadedWorker,
      task: ThreadedTask<TArgs, TResult>,
      args: TArgs
   ): Promise<Awaited<TResult>> {
      await slot.ready;
      await this.workerSemaphore?.acquire();
      const isReleased = false;

      return await new Promise<Awaited<TResult>>((resolve, reject) => {
         const taskId = this.nextTaskId++;
         let settled = false;
         let timeout: NodeJS.Timeout | undefined;

         const settle = (callback: () => void): void => {
            if (settled) return;
            settled = true;
            if (!isReleased && this.workerSemaphore)
               this.workerSemaphore.release();
            if (timeout) clearTimeout(timeout);
            cleanup();
            callback();
         };
         const onMessage = (message: WorkerMessage<Awaited<TResult>>): void => {
            if (message.id !== taskId) return;
            settle(() => {
               if (message.error) {
                  const error = new Error(message.error.message);
                  error.stack = message.error.stack;
                  reject(error);
                  return;
               }
               resolve(message.result as Awaited<TResult>);
            });
         };
         const onError = (error: Error): void => {
            settle(() => {
               this.removeWorker(slot);
               reject(error);
            });
         };
         const onExit = (code: number): void => {
            if (code === 0) return;
            settle(() => {
               this.removeWorker(slot);
               reject(new Error(`Threaded worker exited with code ${code}.`));
            });
         };
         const cleanup = (): void => {
            slot.worker.off('message', onMessage);
            slot.worker.off('error', onError);
            slot.worker.off('exit', onExit);
         };

         if (this.taskTimeout !== undefined) {
            timeout = setTimeout(() => {
               settle(() => {
                  this.removeWorker(slot);
                  void slot.worker.terminate();
                  reject(new Error(`Threaded task timed out after ${this.taskTimeout}ms.`));
               });
            }, this.taskTimeout);
         }

         slot.worker.on('message', onMessage);
         slot.worker.once('error', onError);
         slot.worker.once('exit', onExit);
         slot.worker.postMessage({
            args,
            id: taskId,
            taskSource: task.toString(),
         });
      }).catch((error) => {
         if (!isReleased && this.workerSemaphore)
            this.workerSemaphore.release();
         throw new Error(`Threaded task failed: ${Err.from(error)}`);
      });
   }

   private removeWorker(slot: ThreadedWorker): void {
      slot.terminated = true;
      this.workers.delete(slot);
      const idleIndex = this.idleWorkers.indexOf(slot);
      if (idleIndex !== -1) this.idleWorkers.splice(idleIndex, 1);
   }
}

/**
 * Validates names injected into the worker global scope.
 * @param name - Candidate JavaScript identifier.
 */
function assertIdentifier(name: string): void {
   if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
      throw new Error(`Invalid worker requirement name '${name}'.`);
   }
}

/**
 * Converts a shared value into source that can be evaluated in a worker.
 * @param value - Value to expose to worker tasks.
 * @param seen - Objects already visited while serializing.
 * @returns JavaScript source expression for the value.
 */
function stringifyWorkerValue(value: unknown, seen = new WeakSet<object>()): string {
   if (typeof value === 'function') return stringifyWorkerFunction(value);
   if (value === undefined) return 'undefined';
   if (value === null) return 'null';
   if (typeof value === 'bigint') return `${value.toString()}n`;
   if (typeof value !== 'object') return JSON.stringify(value);

   if (seen.has(value)) {
      throw new Error('Worker requirement values cannot contain circular references.');
   }
   seen.add(value);

   if (Array.isArray(value)) {
      const source = `[${value.map((item) => stringifyWorkerValue(item, seen)).join(',')}]`;
      seen.delete(value);
      return source;
   }

   const entries = Object.entries(value)
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stringifyWorkerValue(entryValue, seen)}`)
      .join(',');
   seen.delete(value);
   return `({${entries}})`;
}

/**
 * Converts a function or object method into an evaluable function expression.
 * @param value - Function to serialize.
 * @returns JavaScript source expression for the function.
 */
function stringifyWorkerFunction(value: { toString(): string }): string {
   const source = value.toString();
   if (/^(async\s+)?function\b/.test(source) || /^(async\s*)?\(/.test(source)) return source;
   if (/^async\s+[\w$]+\s*\(/.test(source)) return source.replace(/^async\s+/, 'async function ');
   if (/^[\w$]+\s*\(/.test(source)) return `function ${source}`;
   return source;
}

export default Threaded;
