import { describe, expect, it } from 'bun:test';

import { Semaphore } from '@/utils/operation';

describe('operation.Semaphore', () => {
   it('should allow acquiring and releasing permits', async () => {
      const semaphore = new Semaphore(2);

      // Acquire first permit
      await semaphore.acquire();
      expect(semaphore.available()).toBe(1);

      // Acquire second permit
      await semaphore.acquire();
      expect(semaphore.available()).toBe(0);

      // Attempt to acquire third permit (should wait)
      let acquiredThird = false;
      const acquireThird = semaphore.acquire().then(() => {
         acquiredThird = true;
      });

      // Ensure third acquire is waiting
      expect(acquiredThird).toBe(false);

      // Release one permit
      semaphore.release(); // still zero after release because this release causes third to work in place of second
      expect(semaphore.available()).toBe(0);
      semaphore.release();
      expect(semaphore.available()).toBe(1);

      // Wait for third acquire to resolve
      await acquireThird;
      expect(acquiredThird).toBe(true);
      expect(semaphore.available()).toBe(1);
      semaphore.release();
      expect(semaphore.available()).toBe(2);
   });

   it('should not allow acquiring more than max permits', async () => {
      const semaphore = new Semaphore(1);

      // Acquire the only permit
      await semaphore.acquire();
      expect(semaphore.available()).toBe(0);

      // Attempt to acquire another permit (should wait)
      let acquiredSecond = false;
      const acquireSecond = semaphore.acquire().then(() => {
         acquiredSecond = true;
      });

      // Ensure second acquire is waiting
      expect(acquiredSecond).toBe(false);

      // Release the permit
      semaphore.release();
      expect(semaphore.available()).toBe(0);

      // Wait for second acquire to resolve
      await acquireSecond;
      expect(acquiredSecond).toBe(true);
      semaphore.release();
      expect(semaphore.available()).toBe(1);
   });

   it('should respect timeouts when acquiring permits', async () => {
      const semaphore = new Semaphore(1, 10); // 10ms timeout

      // Acquire the only permit
      await semaphore.acquire();
      expect(semaphore.available()).toBe(0);

      // Attempt to acquire another permit (should timeout)
      let acquiredSecond = false;
      const acquireSecond = semaphore.acquire().then(() => {
         acquiredSecond = true;
      });

      // Wait for timeout to occur
      await acquireSecond;
      expect(acquiredSecond).toBe(true); // Should resolve even on timeout
      expect(semaphore.available()).toBe(0); // Still no permits available
   }, { timeout: 100 });
});
