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

export const ZCacheStructure = bd.object({
   meta: ZCacheMetadata,
   data: bd.record(bd.unknown()),
   entryMeta: bd.record(ZCacheEntryMetadata),
});
export type CacheStructure = bd.Infer<typeof ZCacheStructure>;
