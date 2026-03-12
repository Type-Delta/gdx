import * as bd from 'banditypes';

import { GDX_CACHE_SCHEMA_VERSION } from '@/consts';

const ZCacheMetadata = bd.object({
   version: bd.string(),
   cacheSchemaVersion: bd.enums([GDX_CACHE_SCHEMA_VERSION]), // single value enum is literal
   createdAt: bd.number(),
   updatedAt: bd.number(),
   lastPruneAt: bd.number(),
});

const ZCacheEntryMetadata = bd.object({
   createdAt: bd.number(),
   updatedAt: bd.number(),
   expiresAt: bd.number(),
});
export type CacheEntryMetadata = bd.Infer<typeof ZCacheEntryMetadata>;

export const ZLanguageRecord = bd.object({
   name: bd.string(),
   extensions: bd.array(bd.string()),
   filenames: bd.array(bd.string()),
   color: bd.number(),
   id: bd.number(),
});
export type LanguageRecord = bd.Infer<typeof ZLanguageRecord>;

export const ZStoredLanguageCatalog = bd.object({
   lastUpdatedAt: bd.string(),
   languages: bd.array(ZLanguageRecord),
});
export type StoredLanguageCatalog = bd.Infer<typeof ZStoredLanguageCatalog>;

export const ZCacheStructure = bd.object({
   meta: ZCacheMetadata,
   data: bd.record(bd.unknown()),
   entryMeta: bd.record(ZCacheEntryMetadata),
});
export type CacheStructure = bd.Infer<typeof ZCacheStructure>;
