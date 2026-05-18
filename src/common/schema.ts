import { GDX_CACHE_SCHEMA_VERSION } from '@/consts';
import { Type as t, type Static } from '@/modules/typebox';

const ZCacheMetadata = t.Object({
   version: t.String(),
   cacheSchemaVersion: t.Literal(GDX_CACHE_SCHEMA_VERSION),
   createdAt: t.Number(),
   updatedAt: t.Number(),
   lastPruneAt: t.Number(),
});

const ZCacheEntryMetadata = t.Object({
   createdAt: t.Number(),
   updatedAt: t.Number(),
   expiresAt: t.Number(),
});
export type CacheEntryMetadata = Static<typeof ZCacheEntryMetadata>;

export const ZLanguageRecord = t.Object({
   name: t.String(),
   extensions: t.Array(t.String()),
   filenames: t.Optional(t.Array(t.String())),
   color: t.Number(),
   id: t.Optional(t.Number()),
});
export type LanguageRecord = Static<typeof ZLanguageRecord>;

export const ZStoredLanguageCatalog = t.Object({
   lastUpdatedAt: t.String(),
   languages: t.Array(ZLanguageRecord),
});
export type StoredLanguageCatalog = Static<typeof ZStoredLanguageCatalog>;

export const ZCacheStructure = t.Object({
   meta: ZCacheMetadata,
   data: t.Record(t.String(), t.Unknown()),
   entryMeta: t.Record(t.String(), ZCacheEntryMetadata),
});
export type CacheStructure = Static<typeof ZCacheStructure>;
