import { describe, expect } from 'bun:test';
import fs from 'fs/promises';
import litedent from 'litedent';
import path from 'path';

import { loadLocalWordlist } from '@/modules/spellcheck';
import { createTestEnv } from '@/utils/testHelper';

describe('spellcheck module', async () => {
   const { tmpRootDir, it } = await createTestEnv({
      liteMode: true,
      suitName: 'spellcheck',
   });

   /**
    * Creates an isolated project directory for a single case.
    * @param name - Unique directory name under the suite temp root.
    * @returns The absolute path of the created directory.
    */
   async function makeProject(name: string): Promise<string> {
      const dir = path.join(tmpRootDir, 'projects', name);
      await fs.mkdir(dir, { recursive: true });
      return dir;
   }

   it('should return empty lists when the repo has no local config', async () => {
      const root = await makeProject('empty');

      const wordlist = await loadLocalWordlist(root);

      expect(wordlist.words).toEqual([]);
      expect(wordlist.ignoreWords).toEqual([]);
      expect(wordlist.flagWords).toEqual([]);
      expect(wordlist.sources).toEqual([]);
   });

   it('should read cSpell wordlists from .vscode/settings.json', async () => {
      const root = await makeProject('vscode');
      const settingsPath = path.join(root, '.vscode', 'settings.json');
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(
         settingsPath,
         litedent`
            {
               // Formatting preferences are irrelevant here.
               "editor.formatOnSave": true,
               /* block comment with a "quoted, comma" inside */
               "cSpell.words": ["Catppuccin", "VPALETTE"],
               "cSpell.userWords": ["medoid"],
               "cSpell.ignoreWords": ["asdfgh"],
               "cSpell.flagWords": ["hte"],
            }
         `
      );

      const wordlist = await loadLocalWordlist(root);

      expect(wordlist.words).toEqual(['Catppuccin', 'VPALETTE', 'medoid']);
      expect(wordlist.ignoreWords).toEqual(['asdfgh']);
      expect(wordlist.flagWords).toEqual(['hte']);
      expect(wordlist.sources).toEqual([settingsPath]);
   });

   it('should accept the nested cSpell section form', async () => {
      const root = await makeProject('vscode-nested');
      const settingsPath = path.join(root, '.vscode', 'settings.json');
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(
         settingsPath,
         JSON.stringify({ cSpell: { words: ['ghelp', 'nocap'] } }, null, 3)
      );

      const wordlist = await loadLocalWordlist(root);

      expect(wordlist.words).toEqual(['ghelp', 'nocap']);
      expect(wordlist.sources).toEqual([settingsPath]);
   });

   it('should merge a cspell config file with .vscode/settings.json', async () => {
      const root = await makeProject('merged');
      const settingsPath = path.join(root, '.vscode', 'settings.json');
      const cspellPath = path.join(root, 'cspell.json');
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(settingsPath, JSON.stringify({ 'cSpell.words': ['jsdiff'] }));
      await fs.writeFile(
         cspellPath,
         JSON.stringify({ version: '0.2', words: ['fflate', 'jsdiff'], ignoreWords: ['zzzz'] })
      );

      const wordlist = await loadLocalWordlist(root);

      // Duplicates across sources collapse, first-seen order wins.
      expect(wordlist.words).toEqual(['jsdiff', 'fflate']);
      expect(wordlist.ignoreWords).toEqual(['zzzz']);
      expect(wordlist.sources).toHaveLength(2);
      expect(wordlist.sources[0]).toBe(settingsPath);
      expect(wordlist.sources[1]).toContain('cspell.json');
   });

   it('should pick up custom dictionary files declared by a cspell config', async () => {
      const root = await makeProject('custom-dict');
      await fs.writeFile(path.join(root, 'project-words.txt'), 'litedent\nufuzzy\n');
      await fs.writeFile(
         path.join(root, 'cspell.json'),
         JSON.stringify({
            version: '0.2',
            dictionaryDefinitions: [{ name: 'project-words', path: './project-words.txt' }],
            dictionaries: ['project-words'],
         })
      );

      const wordlist = await loadLocalWordlist(root);

      expect(wordlist.dictionaries).toContain('project-words');
      expect(wordlist.dictionaryDefinitions?.map((def) => def.name)).toContain('project-words');
   });

   it('should ignore a malformed settings file instead of throwing', async () => {
      const root = await makeProject('malformed');
      const settingsPath = path.join(root, '.vscode', 'settings.json');
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(settingsPath, '{ "cSpell.words": [ "unclosed"');

      const wordlist = await loadLocalWordlist(root);

      expect(wordlist.words).toEqual([]);
      expect(wordlist.sources).toEqual([]);
   });

   it('should not search above the repository root', async () => {
      const parent = await makeProject('outer');
      const root = path.join(parent, 'inner');
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(
         path.join(parent, 'cspell.json'),
         JSON.stringify({ version: '0.2', words: ['shouldNotLeak'] })
      );

      const wordlist = await loadLocalWordlist(root);

      expect(wordlist.words).toEqual([]);
      expect(wordlist.sources).toEqual([]);
   });
});
