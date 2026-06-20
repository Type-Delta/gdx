import { describe, expect, it } from 'bun:test';

import { $, GDX_HISTORY_GUARD_ENV } from '@/modules/shell';

describe('history subprocess guard', () => {
   it('marks every subprocess launched through the shared shell boundary', async () => {
      const result = await $`${process.execPath} -e ${'process.stdout.write(process.env.GDX_HISTORY_GUARD || "")'}`;

      expect(result.stdout).toBe('1');
      expect(GDX_HISTORY_GUARD_ENV.GDX_HISTORY_GUARD).toBe('1');
   });
});
