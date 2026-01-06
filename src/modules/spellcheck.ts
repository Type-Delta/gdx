import { ncc } from '@lib/Tools';
import type { SpellCheckFileResult } from 'cspell-lib';

export { spellCheckDocument } from 'cspell-lib';

export function prettyFormatIssues(result: SpellCheckFileResult, context: string): string {
   if (result.issues.length === 0) {
      return ncc('Green') + '✓ No spelling issues found!' + ncc();
   }

   let output =
      ncc('Yellow') +
      `✗ Found ${result.issues.length} spelling issue${result.issues.length === 1 ? '' : 's'}:\n` +
      ncc();
   output += ncc('Dim') + '─'.repeat(60) + '\n\n' + ncc();

   const cyan = ncc('Cyan');
   const magenta = ncc('Magenta');
   const redBright = ncc('Red') + ncc('Bright');
   const dim = ncc('Dim');
   const underline = ncc('Underline');

   result.issues.forEach((issue, index) => {
      const before = context.substring(0, issue.line.offset);
      const issueLine = before.length - before.replace(/\n/g, '').length;
      const issueCol = issue.offset - issue.line.offset;

      // Location and word
      output += `${dim}${index + 1}.${ncc()} ${cyan}Line ${issueLine + 1}${ncc()}, ${magenta}Col ${issueCol + 1}${ncc()}: ${redBright}"${issue.text}"${ncc()}\n`;

      // Context line with underline
      const line = issue.line.text;
      if (line) {
         const lineLocalOffset = issue.offset - issue.line.offset;
         const before = line.substring(0, lineLocalOffset);
         const after = line.substring(lineLocalOffset + issue.text.length);
         output += `   ${before}${redBright + underline}${issue.text}${ncc()}${after}\n`;
      }

      // Suggestions
      if (issue.suggestions?.length) {
         const suggs = issue.suggestions.slice(0, 5).join(', ');
         output += `   ${cyan}Suggestions:${ncc()} ${suggs}\n`;
      }

      if (index < result.issues.length - 1) output += '\n';
   });

   output += dim + '─'.repeat(60) + ncc() + '\n';
   return output;
}
