import { Array as TypeArray } from '@node/@sinclair/typebox/build/esm/type/array/index.mjs';
import { Boolean as TypeBoolean } from '@node/@sinclair/typebox/build/esm/type/boolean/index.mjs';
import { Integer as TypeInteger } from '@node/@sinclair/typebox/build/esm/type/integer/index.mjs';
import { Literal as TypeLiteral } from '@node/@sinclair/typebox/build/esm/type/literal/index.mjs';
import { Null as TypeNull } from '@node/@sinclair/typebox/build/esm/type/null/index.mjs';
import { Number as TypeNumber } from '@node/@sinclair/typebox/build/esm/type/number/index.mjs';
import { Object as TypeObject } from '@node/@sinclair/typebox/build/esm/type/object/index.mjs';
import { Optional as TypeOptional } from '@node/@sinclair/typebox/build/esm/type/optional/index.mjs';
import { Record as TypeRecord } from '@node/@sinclair/typebox/build/esm/type/record/index.mjs';
import { FormatRegistry } from '@node/@sinclair/typebox/build/esm/type/registry/index.mjs';
import type { TSchema } from '@node/@sinclair/typebox/build/esm/type/schema/index.mjs';
import type { Static } from '@node/@sinclair/typebox/build/esm/type/static/index.mjs';
import { String as TypeString } from '@node/@sinclair/typebox/build/esm/type/string/index.mjs';
import { Union as TypeUnion } from '@node/@sinclair/typebox/build/esm/type/union/index.mjs';
import { Unknown as TypeUnknown } from '@node/@sinclair/typebox/build/esm/type/unknown/index.mjs';
import { Check } from '@node/@sinclair/typebox/build/esm/value/check/index.mjs';
import { Errors } from '@node/@sinclair/typebox/build/esm/errors/index.mjs';

import { GdxConfigSchema } from '@/common/config/schema';

export type { Static, TSchema };
export { FormatRegistry };

/**
 * Narrow TypeBox builder facade for the runtime schema shapes used by gdx.
 */
export const Type = {
   Array: TypeArray,
   Boolean: TypeBoolean,
   Integer: TypeInteger,
   Literal: TypeLiteral,
   Null: TypeNull,
   Number: TypeNumber,
   Object: TypeObject,
   Optional: TypeOptional,
   Record: TypeRecord,
   String: TypeString,
   Union: TypeUnion,
   Unknown: TypeUnknown,
} as const;

/**
 * Narrow TypeBox value facade for runtime validation used by gdx.
 */
export const Value = {
   Check,
   Errors,
} as const;

export interface ConfigValidationResult {
   valid: boolean;
   message?: string;
}

interface ObjectSchemaLike extends TSchema {
   properties?: Record<string, TSchema>;
}

/**
 * Gets the TypeBox schema for a dot-notation config key.
 * @param keyPath - Dot-notation config key.
 * @returns The TypeBox schema for that leaf key, or undefined for unknown keys.
 */
export function getConfigValueSchema(keyPath: string): TSchema | undefined {
   let schema: TSchema | undefined = GdxConfigSchema;

   for (const key of keyPath.split('.')) {
      const properties: Record<string, TSchema> | undefined = (
         schema as ObjectSchemaLike | undefined
      )?.properties;
      schema = properties?.[key];
      if (!schema) return undefined;
   }

   return schema;
}

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

/**
 * Validates a config value against the schema for a dot-notation key.
 * @param keyPath - Dot-notation config key.
 * @param value - Value to validate.
 * @returns Validation result with a user-facing message when invalid.
 */
export function validateConfigValue(keyPath: string, value: unknown): ConfigValidationResult {
   const schema = getConfigValueSchema(keyPath);
   if (!schema) {
      return { valid: false, message: `Unknown configuration key '${keyPath}'.` };
   }

   if (Value.Check(schema, value)) {
      return { valid: true };
   }

   const allowed = getLiteralUnionValues(schema);
   if (allowed.length > 0) {
      return {
         valid: false,
         message: `Expected one of ${allowed.join(', ')} for '${keyPath}', got '${String(value)}'.`,
      };
   }

   const firstError = [...Value.Errors(schema, value)][0];
   return {
      valid: false,
      message: `Invalid value for '${keyPath}': ${firstError?.message ?? 'schema validation failed'}.`,
   };
}

/**
 * Coerces a string input from the CLI or environment into a typed config value.
 * @param keyPath - Dot-notation config key.
 * @param value - Raw string value.
 * @returns Coerced value, or an error message when coercion/validation fails.
 */
export function coerceConfigStringValue(
   keyPath: string,
   value: string
): { ok: true; value: unknown } | { ok: false; message: string } {
   const schema = getConfigValueSchema(keyPath);
   if (!schema) {
      return { ok: false, message: `Unknown configuration key '${keyPath}'.` };
   }

   let parsedValue: unknown = value;
   const schemaType = getSchemaType(schema);

   if (schemaType === 'number' || schemaType === 'integer') {
      const num = Number(value);
      if (Number.isNaN(num)) {
         return { ok: false, message: `Expected a number for '${keyPath}', got '${value}'` };
      }
      parsedValue = num;
   } else if (schemaType === 'boolean') {
      if (!['true', 'false', 'on', 'off'].includes(value.toLowerCase())) {
         return { ok: false, message: `Expected a boolean for '${keyPath}', got '${value}'` };
      }
      parsedValue = ['true', 'on'].includes(value.toLowerCase());
   } else if (schemaType === 'array') {
      try {
         parsedValue = JSON.parse(value);
      } catch {
         return {
            ok: false,
            message: `Expected a JSON array for '${keyPath}', got '${value}'. Example: ["**/*.foo"]`,
         };
      }
   } else if (acceptsNull(schema) && value.toLowerCase() === 'null') {
      parsedValue = null;
   }

   const validation = validateConfigValue(keyPath, parsedValue);
   if (!validation.valid) {
      return { ok: false, message: validation.message ?? `Invalid value for '${keyPath}'.` };
   }

   return { ok: true, value: parsedValue };
}

function getLiteralUnionValues(schema: TSchema): string[] {
   const variants = getSchemaVariants(schema);
   return variants
      .map((variant) => (variant as { const?: unknown }).const)
      .filter((value): value is string => typeof value === 'string');
}

function getSchemaType(schema: TSchema): string | undefined {
   const direct = (schema as { type?: string }).type;
   if (direct) return direct;

   for (const variant of getSchemaVariants(schema)) {
      const type = (variant as { type?: string }).type;
      if (type && type !== 'null') return type;
   }

   return undefined;
}

function getSchemaVariants(schema: TSchema): TSchema[] {
   return (
      (schema as { anyOf?: TSchema[] }).anyOf ??
      (schema as { oneOf?: TSchema[] }).oneOf ??
      (schema as { allOf?: TSchema[] }).allOf ??
      []
   );
}

function acceptsNull(schema: TSchema): boolean {
   if ((schema as { type?: string }).type === 'null') return true;
   return getSchemaVariants(schema).some(
      (variant) => (variant as { type?: string }).type === 'null'
   );
}
