

/**
 * A simple semaphore implementation for controlling concurrent access to resources.
 */
export class Semaphore {
   private usage: number = 0;
   private max: number;
   private timeout?: number;
   private queue: (() => void)[];

   /**
    * Optional callback that is called when a timeout occurs while waiting to acquire the semaphore. This can be used to log warnings or perform cleanup actions when tasks are waiting too long for the semaphore.
    */
   private _onTimeout: (() => void | Promise<void>) | null = null;

   constructor(count: number, timeout?: number) {
      this.max = Math.max(1, count);
      this.timeout = timeout;
      this.queue = [];
   }

   /**
    * Sets the maximum count for the semaphore. If the new maximum is less than the current usage, it will not reduce the usage but will prevent new acquisitions until the usage drops below the new maximum.
    * @param count - The new maximum count for the semaphore. Must be at least 1.
    */
   setMax(count: number): void {
      this.max = Math.max(1, count);
   }

   /**
    * Acquires the semaphore. If the current usage is below the maximum, it increments the usage and returns immediately.
    * If the usage is at the maximum, it returns a promise that resolves when the semaphore is released by another consumer.
     * If a timeout is specified and the semaphore cannot be acquired within that time, the promise will resolve anyway to prevent deadlocks.
     * Consumers should check if they successfully acquired the semaphore after awaiting this method.
     * @returns A promise that resolves when the semaphore is acquired or when a timeout occurs.
    */
   async acquire(): Promise<void> {
      if (this.usage < this.max) {
         this.usage++;
         return;
      }

      return new Promise((resolve) => {
         const resolver = () => {
            resolve();
         }
         this.queue.push(resolver);

         if (this.timeout) {
            setTimeout(() => {
               this._onTimeout?.();
               const index = this.queue.indexOf(resolver);
               if (index !== -1) {
                  this.queue.splice(index, 1);
                  resolve();
               }
            }, this.timeout);
         }
      });
   }

   /**
    * Releases the semaphore. If there are waiting consumers, it resolves the next one in the queue.
    * Otherwise, it increments the count.
    */
   release(): void {
      if (this.queue.length > 0) {
         const firstConsumer = this.queue.shift();
         firstConsumer!();
      } else if (this.usage > 0) {
         this.usage--;
      }
   }

   /**
    * Returns the number of available permits in the semaphore (i.e., how many more times it can be acquired before reaching the maximum).
    */
   available(): number {
      return this.max - this.usage;
   }

   /**
    * Sets a callback function that will be called when a timeout occurs while waiting to acquire the semaphore. This can be used to log warnings or perform cleanup actions when tasks are waiting too long for the semaphore.
    * @param callback - The function to call when a timeout occurs.
    */
   onTimeout(callback: () => void | Promise<void>): this {
      this._onTimeout = callback;
      return this;
   }
}
