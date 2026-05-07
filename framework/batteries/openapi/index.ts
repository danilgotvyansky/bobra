import * as v from 'valibot';
import { toJsonSchema } from '@valibot/to-json-schema';
import type { OpenAPIV3 } from 'openapi-types';
export * from './merge-openapi';

type JsonSchemaObject = {
  [key: string]: unknown;
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  allOf?: unknown[];
  anyOf?: unknown[];
  items?: unknown;
  enum?: unknown[];
  const?: unknown;
  additionalProperties?: boolean;
  example?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Generate schema reference for OpenAPI
 */
export function generateSchemaRef(schemaName: string): { $ref: string } {
  return { $ref: `#/components/schemas/${schemaName}` };
}

/**
 * Generate list response schema for OpenAPI.
 * Creates a standardized list response with success, data array, and count.
 */
export function generateListResponseSchema(itemSchemaName: string) {
  return {
    type: 'object' as const,
    properties: {
      success: { type: 'boolean' as const },
      data: {
        type: 'array' as const,
        items: generateSchemaRef(itemSchemaName)
      },
      count: { type: 'number' as const }
    }
  };
}

/**
 * Generate single item response schema for OpenAPI.
 * Creates a standardized response with success and data object.
 */
export function generateResponseSchema(itemSchemaName: string) {
  return {
    type: 'object' as const,
    properties: {
      success: { type: 'boolean' as const },
      data: generateSchemaRef(itemSchemaName)
    }
  };
}

/**
 * Standard error response JSON Schema (plain JSON Schema, not Valibot).
 * Useful directly inside describeRoute responses.
 */
export const errorResponseJsonSchema = {
  type: 'object' as const,
  properties: {
    success: { type: 'boolean' as const, example: false },
    error: { type: 'string' as const, example: 'Details about the error' },
    details: { type: 'object' as const, additionalProperties: true, example: {} },
  },
} satisfies OpenAPIV3.SchemaObject;

/**
 * Schema that transforms Date | string | null to string | undefined.
 * Handles database Date objects and converts them to ISO string format.
 */
export const dateToStringSchema = v.pipe(
  v.unknown(),
  v.transform((input) => {
    if (!input) return undefined;
    if (typeof input === 'string') return input;
    if (input instanceof Date) return input.toISOString();
    return String(input);
  }),
  v.string(),
  v.isoTimestamp()
);

/**
 * Simple success response wrapper
 */
export const simpleSuccessResponseSchema = v.object({
  success: v.literal(true),
  message: v.string(),
});

export const errorResponseSchema = v.object({
  success: v.literal(false),
  error: v.pipe(v.string(), v.description('Error message')),
  details: v.optional(v.record(v.string(), v.unknown())),
});

/**
 * Convert Valibot query schema to OpenAPI parameters array.
 * Uses @valibot/to-json-schema to automatically extract properties.
 * Supports both ObjectSchema and IntersectSchema (from v.intersect).
 */
export function valibotSchemaToOpenAPIParameters(schema: v.GenericSchema<unknown>): OpenAPIV3.ParameterObject[] {
  const jsonSchema = toJsonSchema(schema) as unknown;

  // Handle allOf (from v.intersect) — merge properties from all schemas
  let properties: Record<string, unknown> = {};
  let required: string[] = [];

  if (isRecord(jsonSchema) && Array.isArray(jsonSchema.allOf)) {
    for (const subSchema of jsonSchema.allOf) {
      if (isRecord(subSchema) && !('const' in subSchema) && !('enum' in subSchema)) {
        if (isRecord(subSchema.properties)) {
          properties = { ...properties, ...subSchema.properties };
        }
        if (Array.isArray(subSchema.required)) {
          required = [
            ...required,
            ...subSchema.required.filter((entry): entry is string => typeof entry === 'string')
          ];
        }
      }
    }
  } else {
    if (isRecord(jsonSchema) && isRecord(jsonSchema.properties)) {
      properties = jsonSchema.properties;
    }
    if (isRecord(jsonSchema) && Array.isArray(jsonSchema.required)) {
      required = jsonSchema.required.filter((entry): entry is string => typeof entry === 'string');
    }
  }

  return Object.entries(properties).map(([name, prop]) => {
    // Convert anyOf with all const values to enum for better OpenAPI compatibility
    let paramSchema = prop as OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject;
    if (isRecord(prop) && Array.isArray(prop.anyOf)) {
      const constValues = prop.anyOf
        .filter(isRecord)
        .filter((item) => Object.prototype.hasOwnProperty.call(item, 'const'))
        .map((item) => item.const);

      if (constValues.length === prop.anyOf.length && constValues.length > 0) {
        paramSchema = {
          type: 'string',
          enum: constValues as (string | number | boolean | null)[]
        };
      }
    }

    return {
      name,
      in: 'query' as const,
      schema: paramSchema,
      required: required.includes(name) || undefined,
    };
  });
}

export const defaultPaginationQuerySchema = v.object({
  limit: v.optional(v.pipe(v.string(), v.regex(/^\d+$/), v.description('Pagination limit as string'))),
  offset: v.optional(v.pipe(v.string(), v.regex(/^\d+$/), v.description('Pagination offset as string'))),
});
