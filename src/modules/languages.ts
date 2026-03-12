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
   LANGUAGE_CACHE_KEY,
   LANGUAGE_FETCH_TIMEOUT_MS,
   LANGUAGE_REFRESH_INTERVAL_MS,
   LANGUAGE_SOURCE_URL
} from '@/consts';
import Logger from '@/utils/logger';
import { SpinnerContoller } from './shell';

type YamlParser = typeof yaml;

const FAILED_FETCH_BACKOFF_MS = 10 * 60 * 1000;
export const DEFAULT_LANGUAGE_COLOR = 0xffffff;

let lastFetchFailureAt = 0;
let parserInstance: YamlParser | null = null;

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
   spinner: SpinnerContoller;
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

   if (!cached && !forceRefresh && Date.now() - lastFetchFailureAt < FAILED_FETCH_BACKOFF_MS) {
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
   if (!extension) return null;
   return catalog.byExtension.get(extension) || null;
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

      const value = rawValue as { extensions?: unknown; color?: unknown; type?: string };
      const extensions = normalizeExtensions(value.extensions);
      if (value.type === 'data') continue; // Skip pure data formats without syntax
      if (extensions.length === 0) continue;

      const color = parseColorToDecimal(value.color) ?? DEFAULT_LANGUAGE_COLOR;
      languages.push({
         name,
         extensions,
         color,
      });
   }

   languages = removeConflictingExtensions(languages);
   languages.sort((a, b) => a.name.localeCompare(b.name));

   return {
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
      const extensions = language.extensions.filter(
         (extension) => (extCount.get(extension) || 0) === 1
      );
      if (extensions.length === 0) continue;
      sanitized.push({
         name: language.name,
         color: language.color,
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
      return ZStoredLanguageCatalog(value);
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
      throw new Error('YAML parser unavailable');
   }
}

export const languageConsts = {
   LANGUAGE_CACHE_KEY,
   INFINITE_TTL_EXPIRES_AT,
} as const;
