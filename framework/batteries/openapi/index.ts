import * as v from 'valibot';
import { toJsonSchema } from '@valibot/to-json-schema';
export { mergeOpenApiSpecs } from './merge-openapi';

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
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      data: {
        type: 'array',
        items: generateSchemaRef(itemSchemaName)
      },
      count: { type: 'number' }
    }
  } as any;
}

/**
 * Generate single item response schema for OpenAPI.
 * Creates a standardized response with success and data object.
 */
export function generateResponseSchema(itemSchemaName: string) {
  return {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      data: generateSchemaRef(itemSchemaName)
    }
  } as any;
}

/**
 * Standard error response JSON Schema (plain JSON Schema, not Valibot).
 * Useful directly inside describeRoute responses.
 */
export const errorResponseJsonSchema: any = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    error: { type: 'string' },
    details: { type: 'object', additionalProperties: true },
  },
};

/**
 * Schema that transforms Date | string | null to string | undefined.
 * Handles database Date objects and converts them to ISO string format.
 */
export const dateToStringSchema = v.pipe(
  v.any(),
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

/**
 * Convert Valibot query schema to OpenAPI parameters array.
 * Uses @valibot/to-json-schema to automatically extract properties.
 * Supports both ObjectSchema and IntersectSchema (from v.intersect).
 */
export function valibotSchemaToOpenAPIParameters(schema: v.GenericSchema<any>): Array<{
  name: string;
  in: 'query';
  schema: any;
  required?: boolean;
  description?: string;
}> {
  const jsonSchema = toJsonSchema(schema);

  // Handle allOf (from v.intersect) — merge properties from all schemas
  let properties: Record<string, any> = {};
  let required: string[] = [];

  if (jsonSchema.allOf && Array.isArray(jsonSchema.allOf)) {
    for (const subSchema of jsonSchema.allOf) {
      if (typeof subSchema === 'object' && subSchema !== null && !('const' in subSchema) && !('enum' in subSchema)) {
        if ('properties' in subSchema && typeof subSchema.properties === 'object' && subSchema.properties !== null) {
          properties = { ...properties, ...subSchema.properties };
        }
        if ('required' in subSchema && Array.isArray(subSchema.required)) {
          required = [...required, ...subSchema.required];
        }
      }
    }
  } else {
    if (typeof jsonSchema === 'object' && jsonSchema !== null && 'properties' in jsonSchema && typeof jsonSchema.properties === 'object' && jsonSchema.properties !== null) {
      properties = jsonSchema.properties || {};
    }
    if (typeof jsonSchema === 'object' && jsonSchema !== null && 'required' in jsonSchema && Array.isArray(jsonSchema.required)) {
      required = jsonSchema.required || [];
    }
  }

  return Object.entries(properties).map(([name, prop]: [string, any]) => {
    // Convert anyOf with all const values to enum for better OpenAPI compatibility
    let paramSchema = prop;
    if (prop.anyOf && Array.isArray(prop.anyOf)) {
      const constValues = prop.anyOf
        .filter((item: any) => item.const !== undefined)
        .map((item: any) => item.const);
      if (constValues.length === prop.anyOf.length && constValues.length > 0) {
        paramSchema = { type: 'string', enum: constValues };
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
