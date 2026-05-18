import type { SpellCheckFileResult } from 'cspell-lib';
import type { spellCheckDocument as CSpellSpellCheckDocument } from 'cspell-lib';
import { SGR } from '@/consts';

let cspellModulePromise: Promise<typeof import('cspell-lib')> | null = null;
let bundledDictionaryNamesPromise: Promise<string[]> | null = null;

async function getCSpell() {
   cspellModulePromise ??= import('cspell-lib');
   return await cspellModulePromise;
}

export async function spellCheckDocument(...args: Parameters<typeof CSpellSpellCheckDocument>) {
   const cspell = await getCSpell();
   return await cspell.spellCheckDocument(...args);
}

/**
 * Gets the names of all dictionaries bundled with the current cspell-lib version.
 */
export async function getBundledDictionaryNames(): Promise<string[]> {
   bundledDictionaryNamesPromise ??= (async () => {
      const cspell = await getCSpell();
      const settings = await cspell.getDefaultBundledSettingsAsync();
      const names = new Set<string>();
      const ordered: string[] = [];
      const addName = (name?: string) => {
         if (!name || names.has(name)) return;
         names.add(name);
         ordered.push(name);
      };

      settings.dictionaryDefinitions?.forEach((def) => addName(def.name));
      settings.dictionaries?.forEach((name) => addName(name));

      return ordered;
   })();

   return bundledDictionaryNamesPromise;
}

export function prettyFormatIssues(result: SpellCheckFileResult, context: string): string {
   if (result.issues.length === 0) {
      return SGR.green + '✓ No spelling issues found!' + SGR.reset;
   }

   let output =
      SGR.yellow +
      `✗ Found ${result.issues.length} spelling issue${result.issues.length === 1 ? '' : 's'}:\n` +
      SGR.reset;
   output += SGR.dim + '─'.repeat(60) + '\n\n' + SGR.reset;

   result.issues.forEach((issue, index) => {
      const before = context.substring(0, issue.line.offset);
      const issueLine = before.length - before.replace(/\n/g, '').length;
      const issueCol = issue.offset - issue.line.offset;

      // Location and word
      output += `${SGR.dim}${index + 1}.${SGR.reset} ${SGR.cyan}Line ${issueLine + 1}${SGR.reset}, ${SGR.magenta}Col ${issueCol + 1}${SGR.reset}: ${SGR.red + SGR.bright}"${issue.text}"${SGR.reset}\n`;

      // Context line with underline
      const line = issue.line.text;
      if (line) {
         const lineLocalOffset = issue.offset - issue.line.offset;
         const before = line.substring(0, lineLocalOffset);
         const after = line.substring(lineLocalOffset + issue.text.length);
         output += `   ${before}${SGR.red + SGR.bright + SGR.underline}${issue.text}${SGR.reset}${after}\n`;
      }

      // Suggestions
      if (issue.suggestions?.length) {
         const suggs = issue.suggestions.slice(0, 5).join(', ');
         output += `   ${SGR.cyan}Suggestions:${SGR.reset} ${suggs}\n`;
      }

      if (index < result.issues.length - 1) output += '\n';
   });

   output += SGR.dim + '─'.repeat(60) + SGR.reset + '\n';
   return output;
}
