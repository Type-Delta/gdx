import path from 'path';
import type yaml from 'yaml';

import { Err } from '@lib/Tools';

import { INFINITE_TTL_EXPIRES_AT, getCache } from '@/common/cache';
import {
   type LanguageRecord,
   type StoredLanguageCatalog,
   ZStoredLanguageCatalog,
} from '@/common/schema';
import {
   EXTENSION_LANG_MAP,
   LANGUAGE_CATALOG_VERSION,
   LANGUAGE_CACHE_KEY,
   LANGUAGE_FETCH_TIMEOUT_MS,
   LANGUAGE_REFRESH_INTERVAL_MS,
   LANGUAGE_SOURCE_URL,
   LANGUAGE_WHITELIST,
} from '@/consts';
import Logger from '@/utils/logger';
import { SpinnerController } from './shell';
import { assertSchema } from './typebox';

type YamlParser = typeof yaml;

const FAILED_FETCH_BACKOFF_MS = 10 * 60 * 1000;
export const DEFAULT_LANGUAGE_COLOR = 0xffffff;

let lastFetchFailureAt = 0;
let parserInstance: YamlParser | null = null;
let shikiLanguageIndexPromise: Promise<Map<string, string>> | null = null;

export interface LanguageCatalog extends StoredLanguageCatalog {
   byExtension: Map<string, LanguageRecord>;
}

/**
 * Gets normalized language metadata from cache or Linguist source.
 *
 * This fetches the latest source when cache is stale, stores a reduced catalog
 * in cache with infinite TTL, and falls back to cached data when update fails.
 *
 * @param options - Optional behavior controls.
 * @returns Language catalog or null when no catalog is available.
 */
export async function getLanguageCatalog(options?: {
   spinner: SpinnerController;
   forceRefresh?: boolean;
}): Promise<LanguageCatalog | null> {
   const forceRefresh = !!options?.forceRefresh;
   const spinner = options?.spinner;

   const cache = await getCache();
   const cachedRaw = await cache.get<unknown>(LANGUAGE_CACHE_KEY);
   const cached = parseStoredLanguageCatalog(cachedRaw);

   if (cached && !forceRefresh && !shouldRefresh(cached.lastUpdatedAt)) {
      return buildLanguageCatalog(cached);
   }

   if (
      !cached &&
      cachedRaw === undefined &&
      !forceRefresh &&
      Date.now() - lastFetchFailureAt < FAILED_FETCH_BACKOFF_MS
   ) {
      return null;
   }

   try {
      if (spinner) {
         spinner.setMessage('Updating language catalog...');
      }
      const rawYaml = await fetchLanguagesYaml();
      const parser = await getYamlPurser();
      const nextCatalog = parseLanguagesYaml(rawYaml, parser);
      await cache.set(LANGUAGE_CACHE_KEY, nextCatalog, { maxAgeMinutes: Infinity });
      return buildLanguageCatalog(nextCatalog);
   } catch (err) {
      lastFetchFailureAt = Date.now();
      Logger.warn(`Failed to refresh language catalog: ${Err.from(err).message}`, 'languages');
      return cached ? buildLanguageCatalog(cached) : null;
   }
}

/**
 * Finds a language record for a file path based on extension.
 *
 * @param catalog - Loaded language catalog.
 * @param filePath - File path to inspect.
 * @returns The matching language record, or null if unknown.
 */
export function inferLanguageFromPath(
   catalog: LanguageCatalog,
   filePath: string
): LanguageRecord | null {
   const extension = path.extname(filePath).toLowerCase();
   const filename = path.basename(filePath);

   // First check for exact filename match (e.g. "Makefile")
   const byFilename = catalog.languages.find((lang) => lang.filenames?.includes(filename));
   if (byFilename) return byFilename;

   // Then check for extension match (e.g. ".js")
   if (!extension) return null;
   return catalog.byExtension.get(extension) || null;
}

/**
 * Resolves a file path to a Shiki bundled language identifier.
 *
 * Catalog matches use GitHub Linguist metadata for filenames and extensions,
 * then map the Linguist language name to Shiki's bundled language ids.
 *
 * @param filePath - File path to inspect.
 * @param catalog - Optional loaded Linguist catalog.
 * @returns Shiki bundled language id, or `plaintext` when no match is available.
 */
export async function resolveShikiLanguageIdForPath(
   filePath: string,
   catalog?: LanguageCatalog | null
): Promise<string> {
   if (catalog) {
      const language = inferLanguageFromPath(catalog, filePath);
      if (language) {
         const shikiLanguage = await resolveShikiLanguageIdFromLanguageName(language.name);
         if (shikiLanguage) return shikiLanguage;
      }
   }

   return (await resolveShikiLanguageIdFromPathToken(filePath)) || 'plaintext';
}

/**
 * Resolves a GitHub Linguist language name to a Shiki bundled language id.
 * @param languageName - Linguist language name.
 * @returns Shiki bundled language id, or null when unsupported by Shiki.
 */
export async function resolveShikiLanguageIdFromLanguageName(
   languageName: string
): Promise<string | null> {
   const mapped = EXTENSION_LANG_MAP[languageName];
   if (mapped) return mapped;

   const index = await getShikiLanguageIndex();
   return index.get(normalizeLanguageKey(languageName)) || null;
}

/**
 * Parses the Linguist language YAML into a reduced cache structure.
 *
 * @param rawYaml - Raw YAML content.
 * @returns Reduced language catalog with update timestamp.
 */
function parseLanguagesYaml(rawYaml: string, parser: YamlParser): StoredLanguageCatalog {
   const parsed = parser.parse(rawYaml) as Record<string, unknown>;
   let languages: LanguageRecord[] = [];

   for (const [name, rawValue] of Object.entries(parsed || {})) {
      if (!rawValue || typeof rawValue !== 'object') continue;

      const value = rawValue as {
         extensions?: unknown;
         color?: unknown;
         type?: string;
         language_id: number;
         filenames?: unknown;
      };
      const extensions = normalizeExtensions(value.extensions);
      const filenames = normalizeFilenames(value.filenames);
      if (value.type === 'data' && !LANGUAGE_WHITELIST.includes(value.language_id)) continue; // Skip pure data formats without syntax
      if (extensions.length === 0 && filenames.length === 0) continue;

      const color = parseColorToDecimal(value.color) ?? DEFAULT_LANGUAGE_COLOR;
      languages.push({
         name,
         extensions,
         color,
         filenames,
         id: value.language_id,
      });
   }

   languages = removeConflictingExtensions(languages);
   languages.sort((a, b) => a.name.localeCompare(b.name));

   return {
      catalogVersion: LANGUAGE_CATALOG_VERSION,
      lastUpdatedAt: new Date().toISOString(),
      languages,
   };
}

/**
 * Fetches remote Linguist YAML with timeout protection.
 *
 * @returns Raw YAML payload.
 */
async function fetchLanguagesYaml(): Promise<string> {
   const abortCtrl = new AbortController();
   const timeout = setTimeout(() => abortCtrl.abort(), LANGUAGE_FETCH_TIMEOUT_MS);

   try {
      const response = await fetch(LANGUAGE_SOURCE_URL, {
         signal: abortCtrl.signal,
      });

      if (!response.ok) {
         throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      return await response.text();
   } finally {
      clearTimeout(timeout);
   }
}

/**
 * Builds a fast extension lookup map from stored catalog.
 *
 * @param stored - Stored catalog payload.
 * @returns Runtime catalog with extension index.
 */
function buildLanguageCatalog(stored: StoredLanguageCatalog): LanguageCatalog {
   const languages = removeConflictingExtensions(stored.languages);
   const byExtension = new Map<string, LanguageRecord>();

   for (const language of languages) {
      for (const extension of language.extensions) {
         if (!byExtension.has(extension)) {
            byExtension.set(extension, language);
         }
      }
   }

   return {
      catalogVersion: stored.catalogVersion,
      lastUpdatedAt: stored.lastUpdatedAt,
      languages,
      byExtension,
   };
}

/**
 * Removes file extensions that are shared by more than one language.
 *
 * This intentionally drops ambiguous extensions from all colliding languages
 * to avoid false positives when extension-only inference is used.
 *
 * @param languages - Language records to sanitize.
 * @returns New language records with conflicting extensions removed.
 */
function removeConflictingExtensions(languages: LanguageRecord[]): LanguageRecord[] {
   const extCount = new Map<string, number>();

   for (const language of languages) {
      for (const extension of language.extensions) {
         extCount.set(extension, (extCount.get(extension) || 0) + 1);
      }
   }

   const sanitized: LanguageRecord[] = [];
   for (const language of languages) {
      if (language.id !== undefined && LANGUAGE_WHITELIST.includes(language.id)) {
         sanitized.push(language);
         continue;
      }

      const extensions = language.extensions.filter(
         (extension) => (extCount.get(extension) || 0) === 1
      );
      if (extensions.length === 0 && (language.filenames?.length || 0) === 0) continue;
      sanitized.push({
         ...language,
         extensions,
      });
   }

   return sanitized;
}

/**
 * Checks whether a cached catalog should be refreshed.
 *
 * @param lastUpdatedAt - ISO timestamp of last update.
 * @returns True when refresh is needed.
 */
function shouldRefresh(lastUpdatedAt: string): boolean {
   const updatedAt = Date.parse(lastUpdatedAt);
   if (!Number.isFinite(updatedAt)) return true;
   return Date.now() - updatedAt >= LANGUAGE_REFRESH_INTERVAL_MS;
}

/**
 * Normalizes extension arrays to unique lowercase values.
 *
 * @param extensionsInput - Raw `extensions` field from YAML.
 * @returns Normalized extension list.
 */
function normalizeExtensions(extensionsInput: unknown): string[] {
   if (!Array.isArray(extensionsInput)) return [];

   const set = new Set<string>();
   for (const ext of extensionsInput) {
      if (typeof ext !== 'string') continue;
      const normalized = ext.trim().toLowerCase();
      if (!normalized.startsWith('.')) continue;
      if (normalized.length <= 1) continue;
      set.add(normalized);
   }

   return Array.from(set);
}

/**
 * Normalizes filename arrays to unique values.
 * @param filenamesInput - Raw `filenames` field from YAML.
 * @returns Normalized filename list.
 */
function normalizeFilenames(filenamesInput: unknown): string[] {
   if (!Array.isArray(filenamesInput)) return [];

   const set = new Set<string>();
   for (const filename of filenamesInput) {
      if (typeof filename !== 'string') continue;
      const normalized = filename.trim();
      if (!normalized) continue;
      set.add(normalized);
   }

   return Array.from(set);
}

/**
 * Resolves a path by matching its basename and extension against Shiki ids and aliases.
 * Used as a no-catalog fallback.
 * @param filePath - File path to inspect.
 * @returns Shiki bundled language id, or null when no Shiki token matches.
 */
async function resolveShikiLanguageIdFromPathToken(filePath: string): Promise<string | null> {
   const index = await getShikiLanguageIndex();
   const basename = path.basename(filePath);
   const extension = path.extname(filePath).slice(1);

   return (
      index.get(normalizeLanguageKey(basename)) ||
      (extension ? index.get(normalizeLanguageKey(extension)) : undefined) ||
      null
   );
}

/**
 * Builds an index of Shiki bundled language names, ids, and aliases.
 * @returns Normalized Shiki language lookup.
 */
async function getShikiLanguageIndex(): Promise<Map<string, string>> {
   shikiLanguageIndexPromise ??= buildShikiLanguageIndex();
   return await shikiLanguageIndexPromise;
}

/**
 * Loads Shiki metadata and builds the lookup used for language resolution.
 * @returns Normalized Shiki language lookup.
 */
async function buildShikiLanguageIndex(): Promise<Map<string, string>> {
   const { bundledLanguagesInfo } = await import('shiki');
   const index = new Map<string, string>();

   for (const language of bundledLanguagesInfo) {
      addShikiLanguageIndexEntry(index, language.id, language.id);
      addShikiLanguageIndexEntry(index, language.name, language.id);

      for (const alias of language.aliases || []) {
         addShikiLanguageIndexEntry(index, alias, language.id);
      }
   }

   return index;
}

/**
 * Adds a language lookup key while preserving the first bundled match.
 * @param index - Lookup index being built.
 * @param key - Human language name, id, or alias.
 * @param languageId - Shiki bundled language id.
 */
function addShikiLanguageIndexEntry(index: Map<string, string>, key: string, languageId: string) {
   const normalized = normalizeLanguageKey(key);
   if (normalized && !index.has(normalized)) index.set(normalized, languageId);
}

/**
 * Normalizes language names for Shiki/Linguist matching.
 * @param value - Language name, alias, id, filename, or extension token.
 * @returns Normalized lookup key.
 */
function normalizeLanguageKey(value: string): string {
   return value.trim().toLowerCase().replace(/[_\s]+/g, '-');
}

/**
 * Converts a language hex color string to decimal RGB value.
 *
 * @param colorInput - Color string from YAML (e.g. "#3178c6").
 * @returns Decimal color value or null when unavailable/invalid.
 */
function parseColorToDecimal(colorInput: unknown): number | null {
   if (typeof colorInput !== 'string') return null;
   const trimmed = colorInput.trim();

   const six = trimmed.match(/^#?([\da-fA-F]{6})$/);
   if (six) {
      return parseInt(six[1], 16);
   }

   const three = trimmed.match(/^#?([\da-fA-F]{3})$/);
   if (three) {
      const expanded = three[1]
         .split('')
         .map((ch) => ch + ch)
         .join('');
      return parseInt(expanded, 16);
   }

   return null;
}

/**
 * Validates and parses stored catalog payload from unknown input.
 *
 * @param value - Unknown cached value.
 * @returns Parsed catalog or null when validation fails.
 */
function parseStoredLanguageCatalog(value: unknown): StoredLanguageCatalog | null {
   try {
      return assertSchema(ZStoredLanguageCatalog, value);
   } catch {
      return null;
   }
}

async function getYamlPurser() {
   if (parserInstance) return parserInstance;

   try {
      parserInstance = await import('yaml');
      return parserInstance;
   } catch (err) {
      Logger.error(
         `Failed to load YAML parser for language catalog: ${Err.from(err).message}`,
         'languages'
      );
      throw new Error('YAML parser unavailable', { cause: err });
   }
}

export const languageConsts = {
   LANGUAGE_CATALOG_VERSION,
   LANGUAGE_CACHE_KEY,
   INFINITE_TTL_EXPIRES_AT,
} as const;
