/**
 * Minimal, tree-shaking-friendly surface of the `diff` (jsdiff) package.
 *
 * Importing the package entry point (`'diff'`) pulls every differ
 * (`json`, `css`, `sentence`, `array`) and the full patch toolkit
 * (`apply`, `parse`, `reverse`, converters) into the bundle (~58KB).
 * gdx only needs character/word diffing and `structuredPatch`, so we
 * deep-import just those modules via the package's `./lib/*.js` export
 * subpaths. Keep this list minimal — adding a broad re-export here
 * re-bloats the bundle.
 *
 * Consumers should lazily `import()` this module (not `'diff'`) so the
 * diffing code stays off the startup critical path.
 */
export { diffChars } from 'diff/lib/diff/character.js';
export { diffWordsWithSpace } from 'diff/lib/diff/word.js';
export { structuredPatch } from 'diff/lib/patch/create.js';
