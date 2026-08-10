import path from 'path';
import { pathToFileURL } from 'url';

import type {
   CSpellSettingsWithSourceTrace,
   CSpellUserSettings,
   SpellCheckFileResult,
} from 'cspell-lib';
import type { spellCheckDocument as CSpellSpellCheckDocument } from 'cspell-lib';

import { Err } from '@lib/Tools';

import { SGR } from '@/consts';
import * as fs from '@/modules/fs';
import Logger from '@/utils/logger';

/** Wordlist-bearing subset of cspell settings that this module collects. */
export type LocalWordlist = Required<
   Pick<CSpellUserSettings, 'words' | 'ignoreWords' | 'flagWords' | 'dictionaries'>
> &
   Pick<CSpellUserSettings, 'dictionaryDefinitions'> & {
      /** Config files that contributed entries, in load order. Empty when nothing was found. */
      sources: string[];
   };

/**
 * VS Code settings keys that hold cspell wordlists, mapped to the
 * {@link LocalWordlist} field they contribute to.
 *
 * The VS Code cspell extension reads these from `.vscode/settings.json`, which
 * cspell-lib itself never looks at.
 */
const VSCODE_WORDLIST_KEYS = {
   words: 'words',
   userWords: 'words',
   ignoreWords: 'ignoreWords',
   flagWords: 'flagWords',
} as const satisfies Record<string, 'words' | 'ignoreWords' | 'flagWords'>;

/** Section prefix used by the VS Code cspell extension, e.g. `cSpell.words`. */
const VSCODE_CSPELL_SECTION = 'cSpell';

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

/**
 * Strips comments and trailing commas from a JSON with Comments (JSONC) document
 * so that it can be handed to `JSON.parse`.
 *
 * Editor config files such as `.vscode/settings.json` are JSONC, not strict JSON.
 * @param source - Raw JSONC text.
 * @returns Text that is safe to pass to `JSON.parse`.
 */
function stripJsonc(source: string): string {
   const out: string[] = [];
   /** Offsets into `out` holding a comma that sits outside of any string. */
   const commaSlots: number[] = [];
   let inString = false;
   let escaped = false;

   for (let i = 0; i < source.length; i++) {
      const char = source[i];

      if (inString) {
         out.push(char);
         if (escaped) escaped = false;
         else if (char === '\\') escaped = true;
         else if (char === '"') inString = false;
         continue;
      }

      if (char === '"') {
         inString = true;
         out.push(char);
         continue;
      }

      const next = source[i + 1];
      if (char === '/' && next === '/') {
         while (i < source.length && source[i] !== '\n') i++;
         // Keep the newline so that error offsets stay roughly aligned.
         if (i < source.length) out.push('\n');
         continue;
      }
      if (char === '/' && next === '*') {
         const end = source.indexOf('*/', i + 2);
         i = end === -1 ? source.length : end + 1;
         continue;
      }

      if (char === ',') commaSlots.push(out.length);
      out.push(char);
   }

   // Drop commas whose next meaningful character closes an object or array.
   for (let s = commaSlots.length - 1; s >= 0; s--) {
      const slot = commaSlots[s];
      let j = slot + 1;
      while (j < out.length && /\s/.test(out[j])) j++;
      if (out[j] === '}' || out[j] === ']') out[slot] = '';
   }

   return out.join('');
}

/**
 * Reads a JSONC file and parses it into a plain object.
 * @param filePath - Absolute path of the file to read.
 * @returns The parsed object, or `null` when the file is missing, unreadable, or malformed.
 */
async function readJsoncFile(filePath: string): Promise<Record<string, unknown> | null> {
   let text: string;
   try {
      text = await fs.readFile(filePath, 'utf-8');
   } catch {
      return null; // Missing file is the normal case, not worth logging.
   }

   try {
      const parsed = JSON.parse(stripJsonc(text));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
   } catch (e) {
      Logger.warn(`Failed to parse ${filePath}: ${Err.from(e).message}`, 'spellcheck');
      return null;
   }
}

/**
 * Coerces a config value into a list of non-empty word strings.
 * @param value - Raw value read from a config file.
 * @returns The contained words, or an empty array when the value is not a string array.
 */
function toWordArray(value: unknown): string[] {
   if (!Array.isArray(value)) return [];
   return value.filter((word): word is string => typeof word === 'string' && word.trim() !== '');
}

/**
 * Collects cspell wordlists from a VS Code workspace settings file.
 *
 * Both the flat (`"cSpell.words": [...]`) and the nested
 * (`"cSpell": { "words": [...] }`) spellings are supported, since VS Code accepts either.
 * @param settingsPath - Absolute path to a `.vscode/settings.json` file.
 * @param target - Wordlist accumulator to append into.
 * @returns `true` when the file contributed at least one word.
 */
async function collectVscodeWordlist(
   settingsPath: string,
   target: LocalWordlist
): Promise<boolean> {
   const settings = await readJsoncFile(settingsPath);
   if (!settings) return false;

   const section = settings[VSCODE_CSPELL_SECTION];
   const nested =
      section && typeof section === 'object' && !Array.isArray(section)
         ? (section as Record<string, unknown>)
         : undefined;

   let found = false;
   for (const [key, field] of Object.entries(VSCODE_WORDLIST_KEYS)) {
      const words = [
         ...toWordArray(settings[`${VSCODE_CSPELL_SECTION}.${key}`]),
         ...toWordArray(nested?.[key]),
      ];
      if (!words.length) continue;
      target[field].push(...words);
      found = true;
   }

   return found;
}

/**
 * Collects wordlists from the project's cspell configuration file, if it has one.
 *
 * cspell-lib resolves the file itself (`cspell.json`, `.cspell.config.yaml`, the
 * `cspell` field of `package.json`, and so on) including any `import` chain, so
 * custom dictionary files declared by the project are picked up too.
 * @param repoRoot - Absolute path of the repository root; the search never leaves it.
 * @param target - Wordlist accumulator to append into.
 * @returns The resolved config file path, or `undefined` when no config was found.
 */
async function collectCSpellConfigWordlist(
   repoRoot: string,
   target: LocalWordlist
): Promise<string | undefined> {
   const cspell = await getCSpell();
   const searchFrom = pathToFileURL(path.join(repoRoot, '/'));

   let settings: CSpellSettingsWithSourceTrace | undefined;
   try {
      settings = await cspell.searchForConfig(searchFrom, { stopSearchAt: searchFrom });
   } catch (e) {
      Logger.warn(
         `Failed to load cspell config from ${repoRoot}: ${Err.from(e).message}`,
         'spellcheck'
      );
      return undefined;
   }
   if (!settings) return undefined;

   target.words.push(...toWordArray(settings.words));
   target.ignoreWords.push(...toWordArray(settings.ignoreWords));
   target.flagWords.push(...toWordArray(settings.flagWords));
   target.dictionaries.push(...toWordArray(settings.dictionaries));
   if (settings.dictionaryDefinitions?.length) {
      // Paths inside these definitions were already resolved relative to the config file.
      target.dictionaryDefinitions = [
         ...(target.dictionaryDefinitions ?? []),
         ...settings.dictionaryDefinitions,
      ];
   }

   const source = settings.source;
   return source?.filename || source?.name || path.join(repoRoot, 'cspell.json');
}

/**
 * Removes duplicates from a word list while preserving first-seen order.
 * @param words - Words to deduplicate.
 * @returns The unique words.
 */
function dedupe(words: string[]): string[] {
   return [...new Set(words)];
}

/**
 * Loads additional wordlists from the repository's own config files, so that terms a
 * project has already taught its editor are not reported as typos.
 *
 * Sources, in load order:
 * - `<repoRoot>/.vscode/settings.json` — `cSpell.words`, `cSpell.userWords`,
 *   `cSpell.ignoreWords`, and `cSpell.flagWords`.
 * - Any cspell config file discoverable at `repoRoot` (`cspell.json`,
 *   `.cspell.config.yaml`, the `cspell` field of `package.json`, ...).
 * @param repoRoot - Absolute path of the repository root.
 * @returns The merged wordlist. All fields are empty when the repo has no such config.
 */
export async function loadLocalWordlist(repoRoot: string): Promise<LocalWordlist> {
   const root = path.resolve(repoRoot);
   const merged: LocalWordlist = {
      words: [],
      ignoreWords: [],
      flagWords: [],
      dictionaries: [],
      sources: [],
   };
   const vscodeSettingsPath = path.join(root, '.vscode', 'settings.json');

   const [hasVscodeWords, cspellConfigPath] = await Promise.all([
      collectVscodeWordlist(vscodeSettingsPath, merged),
      collectCSpellConfigWordlist(root, merged),
   ]);

   if (hasVscodeWords) merged.sources.push(vscodeSettingsPath);
   if (cspellConfigPath) merged.sources.push(cspellConfigPath);

   merged.words = dedupe(merged.words);
   merged.ignoreWords = dedupe(merged.ignoreWords);
   merged.flagWords = dedupe(merged.flagWords);
   merged.dictionaries = dedupe(merged.dictionaries);

   if (merged.sources.length) {
      Logger.debug(
         `Loaded ${merged.words.length} extra word(s) from ${merged.sources.join(', ')}`,
         'spellcheck'
      );
   }
   return merged;
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
