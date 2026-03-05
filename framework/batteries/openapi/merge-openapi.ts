export function mergeOpenApiSpecs(specs: any[], baseInfo?: { title?: string; description?: string; version?: string; }): any {
  const baseInfoDefaults = {
    title: 'API',
    description: 'API documentation',
    version: '1.0.0',
  };
const { title = baseInfoDefaults.title, description = baseInfoDefaults.description, version = baseInfoDefaults.version } = baseInfo || {};
const base = {
    openapi: '3.0.0',
    info: { title, version, description },
    servers: [],
    tags: [] as any[],
    paths: {} as Record<string, any>,
    components: { schemas: {}, securitySchemes: {} } as any,
  };

  const tagSet = new Map<string, any>();
  const schemaSet = new Set<string>();

  for (const spec of specs) {
    if (!spec || typeof spec !== 'object') continue;

    // Merge existing tags (if any)
    for (const tag of spec.tags || []) {
      if (tag && tag.name && !tagSet.has(tag.name)) tagSet.set(tag.name, tag);
    }

    // Extract handler name from spec title (format: "1stLine by Burava API - handler-name")
    const handlerName = spec.info?.title?.split(' - ')[1] || 'Unknown';
    const handlerTag = handlerName.charAt(0).toUpperCase() + handlerName.slice(1);

    // Create handler tag if it doesn't exist
    if (!tagSet.has(handlerTag)) {
      tagSet.set(handlerTag, {
        name: handlerTag,
        description: `API endpoints for ${handlerTag} handler`
      });
    }

    // Merge paths with handler-specific tags
    for (const [path, ops] of Object.entries(spec.paths || {})) {
      if (!base.paths[path]) base.paths[path] = {};

      // Apply handler tag to all operations in this path
      for (const [method, operation] of Object.entries(ops as any)) {
        if (operation && typeof operation === 'object') {
          const op = operation as any;
          if (!op.tags) op.tags = [];
          if (!op.tags.includes(handlerTag)) {
            op.tags.push(handlerTag);
          }
        }
      }

      Object.assign(base.paths[path], ops);
    }

    // Merge components with conflict resolution
    if (spec.components) {
      if (spec.components.schemas) {
        for (const [schemaName, schema] of Object.entries(spec.components.schemas)) {
          // If the conflicting schema is SimpleSuccessResponse or ErrorResponse, leave only 1 (do not prefix)
          if (schemaName === 'SimpleSuccessResponse' || schemaName === 'ErrorResponse' || schemaName === 'IncomingAlertRequest') {
            if (!schemaSet.has(schemaName)) {
              base.components.schemas[schemaName] = schema;
              schemaSet.add(schemaName);
            }
            // Always skip adding any prefixed variant of SimpleSuccessResponse or ErrorResponse
            continue;
          }

          // Handle schema name conflicts by prefixing with handler name if needed
          let finalSchemaName = schemaName;
          if (schemaSet.has(schemaName)) {
            // Try to extract handler name from the spec info title
            const handlerName = spec.info?.title?.split(' - ')[1]?.toLowerCase() || 'unknown';
            finalSchemaName = `${handlerName}_${schemaName}`;
          }

          if (!schemaSet.has(finalSchemaName)) {
            base.components.schemas[finalSchemaName] = schema;
            schemaSet.add(finalSchemaName);
          }
        }
      }
      if (spec.components.securitySchemes) {
        Object.assign(base.components.securitySchemes, spec.components.securitySchemes);
      }
    }

    // Use first spec's servers if present
    if (base.servers.length === 0 && Array.isArray(spec.servers)) {
      base.servers = spec.servers;
    }
  }

  base.tags = Array.from(tagSet.values());

  // Ensure a default BearerAuth scheme exists to enable Swagger UI "Authorize"
  const schemes = (base.components as any).securitySchemes || {};
  if (!schemes.BearerAuth) {
    schemes.BearerAuth = {
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT'
    };
  }
  (base.components as any).securitySchemes = schemes;

  // Apply security globally so operations inherit it by default
  (base as any).security = [{ BearerAuth: [] }];
  return base;
}
