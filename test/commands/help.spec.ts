import { afterAll, describe, it, expect } from 'bun:test';
import help from '@/commands/help';
import { createTestEnv } from '@/utils/testHelper';
import { cleanString } from '@lib/Tools';

describe('gdx help', async () => {
   const { buffer, cleanup } = await createTestEnv();

   afterAll(cleanup);

   it('should print help message', async () => {
      buffer.stdout = '';
      // help command doesn't take context, it takes an optional string name
      const result = help();

      expect(result).toBe(0);
      // @LINK: dn2jka text literal in spec
      expect(cleanString(buffer.stdout)).toContain('Git Developer eXperience');
   });

   it('should print specific command help when name is provided', async () => {
      buffer.stdout = '';
      const result = help('stats');

      expect(result).toBe(0);
      // Stats help should contain stats-specific info
      expect(cleanString(buffer.stdout)).toContain('stats');
   });

   it('should print error for unknown command', async () => {
      buffer.stdout = '';
      const result = help('unknown-command');

      expect(result).toBe(1);
      // @LINK: dnn2j2k text literal in spec
      expect(cleanString(buffer.stdout)).toContain("No help found for 'unknown-command'");
   });
});
