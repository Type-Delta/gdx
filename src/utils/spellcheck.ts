import { ncc } from '@lib/Tools';
import { SpellCheckFileResult } from 'cspell-lib';

export function prettyFormatIssues(result: SpellCheckFileResult, text: string): string {
   if (result.issues.length === 0) {
      return ncc('Green') + '✓ No spelling issues found!' + ncc();
   }

   const lines = text.split('\n');
   let output = ncc('Yellow') + `✗ Found ${result.issues.length} spelling issue${result.issues.length === 1 ? '' : 's'}:\n` + ncc();
   output += ncc('Dim') + '─'.repeat(60) + '\n\n' + ncc();

   const cyan = ncc('Cyan');
   const magenta = ncc('Magenta');
   const redBright = ncc('Red') + ncc('Bright');
   const dim = ncc('Dim');
   const underline = ncc('Underline');

   result.issues.forEach((issue, index) => {
      // Location and word
      output += `${dim}${index + 1}.${ncc()} ${cyan}Line ${issue.line}${ncc()}, ${magenta}Col ${issue.offset + 1}${ncc()}: ${redBright}"${issue.text}"${ncc()}\n`;

      // Context line with underline
      const line = lines[Number(issue.line) - 1];
      if (line) {
         const before = line.substring(0, issue.offset);
         const after = line.substring(issue.offset + issue.text.length);
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
