import { Type, type Static, type TSchema } from '@sinclair/typebox/type';
import { Value } from '@sinclair/typebox/value';

import { GDX_CACHE_SCHEMA_VERSION } from '@/consts';

/**
 * Asserts that a value matches a TypeBox schema.
 *
 * @param schema - TypeBox schema to validate against.
 * @param value - Unknown value to validate.
 * @returns The validated value typed from the schema.
 */
export function assertSchema<T extends TSchema>(schema: T, value: unknown): Static<T> {
   if (Value.Check(schema, value)) {
      return value as Static<T>;
   }

   const firstError = [...Value.Errors(schema, value)][0];
   const path = firstError?.path ? `${firstError.path}: ` : '';
   throw new Error(`${path}${firstError?.message ?? 'Value does not match schema'}`);
}

const ZCacheMetadata = Type.Object({
   version: Type.String(),
   cacheSchemaVersion: Type.Literal(GDX_CACHE_SCHEMA_VERSION),
   createdAt: Type.Number(),
   updatedAt: Type.Number(),
   lastPruneAt: Type.Number(),
});

const ZCacheEntryMetadata = Type.Object({
   createdAt: Type.Number(),
   updatedAt: Type.Number(),
   expiresAt: Type.Number(),
});
export type CacheEntryMetadata = Static<typeof ZCacheEntryMetadata>;

export const ZLanguageRecord = Type.Object({
   name: Type.String(),
   extensions: Type.Array(Type.String()),
   filenames: Type.Optional(Type.Array(Type.String())),
   color: Type.Number(),
   id: Type.Optional(Type.Number()),
});
export type LanguageRecord = Static<typeof ZLanguageRecord>;

export const ZStoredLanguageCatalog = Type.Object({
   lastUpdatedAt: Type.String(),
   languages: Type.Array(ZLanguageRecord),
});
export type StoredLanguageCatalog = Static<typeof ZStoredLanguageCatalog>;

export const ZCacheStructure = Type.Object({
   meta: ZCacheMetadata,
   data: Type.Record(Type.String(), Type.Unknown()),
   entryMeta: Type.Record(Type.String(), ZCacheEntryMetadata),
});
export type CacheStructure = Static<typeof ZCacheStructure>;
