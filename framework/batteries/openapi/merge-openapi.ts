type OpenApiTag = {
  name: string;
  description?: string;
  [key: string]: unknown;
};

type OpenApiDoc = {
  openapi: string;
  info: {
    title: string;
    version: string;
    description: string;
  };
  servers: unknown[];
  tags: OpenApiTag[];
  paths: Record<string, Record<string, unknown>>;
  components: {
    schemas: Record<string, unknown>;
    securitySchemes: Record<string, unknown>;
  };
  security?: Array<Record<string, unknown[]>>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function mergeOpenApiSpecs(specs: unknown[], baseInfo?: { title?: string; description?: string; version?: string; }): OpenApiDoc {
  const baseInfoDefaults = {
    title: 'API',
    description: 'API documentation',
    version: '1.0.0',
  };
  const { title = baseInfoDefaults.title, description = baseInfoDefaults.description, version = baseInfoDefaults.version } = baseInfo || {};

  const base: OpenApiDoc = {
    openapi: '3.0.0',
    info: { title, version, description },
    servers: [],
    tags: [],
    paths: {},
    components: { schemas: {}, securitySchemes: {} },
  };

  const tagSet = new Map<string, OpenApiTag>();
  const schemaSet = new Set<string>();

  for (const spec of specs) {
    if (!isRecord(spec)) continue;

    // Merge existing tags (if present)
    const specTags = Array.isArray(spec.tags) ? spec.tags : [];
    for (const tag of specTags) {
      if (!isRecord(tag) || typeof tag.name !== 'string') continue;
      if (!tagSet.has(tag.name)) {
        tagSet.set(tag.name, tag as OpenApiTag);
      }
    }

    // Extract handler name from spec title (format: "1stLine by Burava API - handler-name")
    const info = isRecord(spec.info) ? spec.info : {};
    const specTitle = typeof info.title === 'string' ? info.title : '';
    const handlerName = specTitle.split(' - ')[1] || 'Unknown';
    const handlerTag = handlerName.charAt(0).toUpperCase() + handlerName.slice(1);

    // Create handler tag if it doesn't exist
    if (!tagSet.has(handlerTag)) {
      tagSet.set(handlerTag, {
        name: handlerTag,
        description: `API endpoints for ${handlerTag} handler`
      });
    }

    // Merge paths with handler-specific tags
    const specPaths = isRecord(spec.paths) ? spec.paths : {};
    for (const [path, ops] of Object.entries(specPaths)) {
      const existingOps = base.paths[path] || {};
      const incomingOps = isRecord(ops) ? ops : {};
      const normalizedOps: Record<string, unknown> = {};

      // Apply handler tag to all operations in this path
      for (const [method, operation] of Object.entries(incomingOps)) {
        if (isRecord(operation)) {
          const tags = toStringArray(operation.tags);
          const nextTags = tags.includes(handlerTag) ? tags : [...tags, handlerTag];
          normalizedOps[method] = {
            ...operation,
            tags: nextTags,
          };
        } else {
          normalizedOps[method] = operation;
        }
      }

      base.paths[path] = { ...existingOps, ...normalizedOps };
    }

    // Merge components with conflict resolution
    const components = isRecord(spec.components) ? spec.components : null;
    if (components) {
      const schemas = isRecord(components.schemas) ? components.schemas : null;
      if (schemas) {
        for (const [schemaName, schema] of Object.entries(schemas)) {
          // If the conflicting schema is SimpleSuccessResponse or ErrorResponse, leave only 1 (do not prefix)
          if (schemaName === 'SimpleSuccessResponse' || schemaName === 'ErrorResponse' || schemaName === 'IncomingAlertRequest') {
            if (!schemaSet.has(schemaName)) {
              base.components.schemas[schemaName] = schema;
              schemaSet.add(schemaName);
            }
            // Always skip adding prefixed variants of SimpleSuccessResponse or ErrorResponse
            continue;
          }

          // Handle schema name conflicts by prefixing with handler name if needed
          let finalSchemaName = schemaName;
          if (schemaSet.has(schemaName)) {
            // Try to extract handler name from the spec info title
            const lowerHandlerName = handlerName.toLowerCase() || 'unknown';
            finalSchemaName = `${lowerHandlerName}_${schemaName}`;
          }

          if (!schemaSet.has(finalSchemaName)) {
            base.components.schemas[finalSchemaName] = schema;
            schemaSet.add(finalSchemaName);
          }
        }
      }

      const securitySchemes = isRecord(components.securitySchemes) ? components.securitySchemes : null;
      if (securitySchemes) {
        Object.assign(base.components.securitySchemes, securitySchemes);
      }
    }

    // Use first spec's servers if present
    if (base.servers.length === 0 && Array.isArray(spec.servers)) {
      base.servers = spec.servers;
    }
  }

  base.tags = Array.from(tagSet.values());

  // Ensure a default BearerAuth scheme exists to enable Swagger UI "Authorize"
  const schemes = base.components.securitySchemes;
  if (!schemes.BearerAuth) {
    schemes.BearerAuth = {
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT'
    };
  }
  base.components.securitySchemes = schemes;

  // Apply security globally so operations inherit it by default
  base.security = [{ BearerAuth: [] }];
  return base;
}

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function collectHandlerNames(discoveryValue: unknown): Set<string> {
  const handlerNames = new Set<string>();
  if (!isObjectRecord(discoveryValue)) {
    return handlerNames;
  }

  const allWorkersValue = discoveryValue.allWorkers;
  if (isObjectRecord(allWorkersValue)) {
    for (const worker of Object.values(allWorkersValue)) {
      if (!isObjectRecord(worker)) {
        continue;
      }

      const handlersValue = worker.handlers;
      if (!Array.isArray(handlersValue)) {
        continue;
      }

      for (const handlerName of handlersValue) {
        if (typeof handlerName === 'string' && handlerName !== 'api-docs') {
          handlerNames.add(handlerName);
        }
      }
    }
  }

  if (handlerNames.size === 0) {
    const initializedHandlersValue = discoveryValue.initializedHandlers;
    if (Array.isArray(initializedHandlersValue)) {
      for (const name of initializedHandlersValue) {
        if (typeof name === 'string') {
          handlerNames.add(name);
        }
      }
    }
  }

  return handlerNames;
}
