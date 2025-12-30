import { afterAll, describe, expect, setSystemTime } from 'bun:test';
import graph from '@/commands/graph';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';
import { cleanString } from '@lib/Tools';

describe('gdx graph', async () => {
   const { tmpDir, $, buffer, cleanup, it } = await createTestEnv();
   const ctx = createGdxContext(tmpDir);
   afterAll(cleanup);

   it('should fail if no email configured (and not provided)', async () => {
      // Unset email
      try {
         // We can't use --unset bc the value would failback to global config if set
         // thus we set it to empty string
         await $`git -C ${tmpDir} config user.email ${''}`;

         const result = await graph(ctx);
         expect(result).toBe(1);
         // LINK: uwnkd11 string literal in spec
         expect(buffer.stdout.toLowerCase()).toContain('user email not configured');
      } finally {
         // Restore email for next tests
         await $`git -C ${tmpDir} config user.email "test@example.com"`;
      }
   });

   it('should generate graph for empty repo', async () => {
      const result = await graph(ctx);
      expect(result).toBe(0);
      // Should print something about generating graph
      expect(buffer.stdout).toContain('Generating commit graph');
   });

   it('should generate graph with commits', async () => {
      // Create some commits
      await $`git -C ${tmpDir} commit --allow-empty -m ${'commit 1'}`;
      await $`git -C ${tmpDir} commit --allow-empty -m ${'commit 2'}`;
      const result = await graph(ctx);

      expect(result).toBe(0);
      // We expect some output. The graph uses special chars, but we can check for "Generating commit graph"
      expect(buffer.stdout).toContain('Generating commit graph');
   });

   it('should respect --email flag', async () => {
      const emailCtx = createGdxContext(tmpDir, ['graph', '--email', 'other@example.com']);
      const result = await graph(emailCtx);

      expect(result).toBe(0);
      expect(buffer.stdout).toContain('other@example.com');
   });

   it('should verify graph layout and date placement', async () => {
      // Set "Today" to Friday, Dec 22, 2023
      const mockDate = new Date('2023-12-22T12:00:00Z');
      setSystemTime(mockDate);

      try {
         // Ensure email is set
         await $`git -C ${tmpDir} config user.email "test@example.com"`;

         // Create commits with specific dates
         // Friday Dec 22, 2023 (Today)
         await $`git -C ${tmpDir} commit --allow-empty -m ${'Fri commit'} --date=${'2023-12-22T12:00:00'}`;

         // Wednesday Dec 20, 2023
         await $`git -C ${tmpDir} commit --allow-empty -m ${'Wed commit'} --date=${'2023-12-20T12:00:00'}`;

         buffer.stdout = '';
         const result = await graph(ctx);
         expect(result).toBe(0);

         const lines = cleanString(buffer.stdout).split('\n');

         // Verify Month Label
         // The header line should contain "Dec" near the end
         const headerLine = lines.find(
            (l) => l.trim().includes('Dec') && !l.includes('Contribution Graph')
         );
         expect(headerLine).toBeDefined();
         // "Dec" should be one of the last labels
         expect(headerLine!.trim().endsWith('Dec')).toBe(true);

         // Verify Rows
         // Row 5 is Friday. It should end with a commit block (■)
         const friRow = lines.find((l) => l.includes('Fri'));
         expect(friRow).toBeDefined();
         // The row ends with a space, so trimEnd()
         // It should end with ■ because we have a commit today
         expect(friRow!.trimEnd().endsWith('■')).toBe(true);

         // Row 3 is Wednesday. It should end with a commit block (■)
         const wedRow = lines.find((l) => l.includes('Wed'));
         expect(wedRow).toBeDefined();
         expect(wedRow!.trimEnd().endsWith('■')).toBe(true);

         // Row 6 is Saturday (unlabeled, follows Fri).
         // It should be empty at the end (future)
         // We need to find the line after Fri
         const friIndex = lines.findIndex((l) => l.includes('Fri'));
         const satRow = lines[friIndex + 1];
         expect(satRow).toBeDefined();

         // The last cell should be empty (spaces), so the line should end with spaces.
         // Note: trimEnd() would remove these spaces and expose the previous week's cell.
         expect(satRow!.endsWith('  ')).toBe(true);
      } finally {
         setSystemTime(); // Reset time
      }
   });
});
