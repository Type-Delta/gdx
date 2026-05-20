import { describe, expect, setSystemTime } from 'bun:test';
import graph from '@/commands/graph';
import { createGdxContext, createTestEnv, setTestGitConfig } from '@/utils/testHelper';
import { cleanString } from '@lib/Tools';

describe('gdx graph', async () => {
   const { tmpDir, $, buffer, it } = await createTestEnv({
      autoResetBuffer: true,
      suitName: 'graph',
   });
   const ctx = createGdxContext(tmpDir);
   const { git$ } = ctx;

   it('should fail if no email configured (and not provided)', async () => {
      // Unset email
      try {
         // We can't use --unset bc the value would failback to global config if set
         // thus we set it to empty string
         await setTestGitConfig(tmpDir, 'user.email', '');

         const result = await graph(ctx);
         expect(result).toBe(1);
         // LINK: uwnkd11 string literal in spec
         expect(buffer.stderr.toLowerCase()).toContain('user email not configured');
      } finally {
         // Restore email for next tests
         await setTestGitConfig(tmpDir, 'user.email', 'test@example.com');
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
      await $`${git$} commit --allow-empty --no-verify -m ${'commit 1'}`;
      await $`${git$} commit --allow-empty --no-verify -m ${'commit 2'}`;
      const result = await graph(ctx);

      expect(result).toBe(0);
      // We expect some output. The graph uses special chars for days with commits, so we can check for those.
      expect(buffer.stdout).toContain('■');
   });

   it('should count commits created after local midnight', async () => {
      process.env.TZ = 'Asia/Bangkok'; // Set timezone to UTC+7 for this test
      // At 01:00 in UTC+7, UTC is still the previous day. The graph should still
      // match Git's local `--date=short` day instead of using a UTC day key.
      setSystemTime(new Date('2026-05-20T01:00:00+07:00'));

      try {
         const author = 'Midnight User <midnight@example.com>';
         const commitDate = '2026-05-20T01:00:00+07:00';
         await $`${git$} commit --allow-empty --no-verify -m ${'after midnight commit'} --author=${author} --date=${commitDate}`;

         const midnightCtx = createGdxContext(tmpDir, ['graph', '--email', 'midnight@example.com']);
         const result = await graph(midnightCtx);

         expect(result).toBe(0);
         expect(buffer.stdout).toContain('■');
      } finally {
         process.env.TZ = undefined;
         setSystemTime();
      }
   });

   it('should respect --email flag', async () => {
      const emailCtx = createGdxContext(tmpDir, ['graph', '--email', 'other@example.com']);
      const result = await graph(emailCtx);

      expect(result).toBe(0);
      expect(buffer.stdout).toContain('other@example.com');
   });

   it('should support --all flag without configured email', async () => {
      await setTestGitConfig(tmpDir, 'user.email', '');

      try {
         const allCtx = createGdxContext(tmpDir, ['graph', '--all']);
         const result = await graph(allCtx);
         expect(result).toBe(0);
         expect(buffer.stdout).toContain('all authors');
      } finally {
         await setTestGitConfig(tmpDir, 'user.email', 'test@example.com');
      }
   });

   it('should verify graph layout and date placement', async () => {
      // Set "Today" to Friday, Dec 22, 2023
      const mockDate = new Date('2023-12-22T12:00:00Z');
      setSystemTime(mockDate);

      try {
         // Create commits with specific dates
         // Friday Dec 22, 2023 (Today)
         await $`${git$} commit --allow-empty --no-verify -m ${'Fri commit'} --date=${'2023-12-22T12:00:00'}`;

         // Wednesday Dec 20, 2023
         await $`${git$} commit --allow-empty --no-verify -m ${'Wed commit'} --date=${'2023-12-20T12:00:00'}`;

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
