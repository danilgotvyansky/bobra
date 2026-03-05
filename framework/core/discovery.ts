import type { Hono } from 'hono';
import type { LoggerConfig } from '../logging/logger';

/**
 * Represents a handler that can be registered with an AppWorker.
 * Each handler is a self-contained unit of business logic with its own routes.
 */
export interface AppHandler {
  name: string;
  version: string;
  routes: Hono<any>;
  componentSchemas?: Record<string, any>;
  // Allow handlers to initialize their own logger with the worker's config
  initLogger?: (config: Partial<LoggerConfig>, context?: string, worker?: string, handler?: string) => void;
  // Allow handlers to perform async initialization (e.g., database connections)
  init?: (env: any) => Promise<void>;
  // Queue processing generic callback
  queue?: (batch: any, env: any, ctx: any) => Promise<void>;
  // Determine if this handler handles the specific queue batch
  handlesQueue?: (queueName: string, configuredQueues: string[]) => boolean;
  // Let the handler mount directly on root path
  ignoreWorkerBasePath?: boolean;
}

/**
 * Represents a registered worker instance with its associated Hono apps.
 */
export interface WorkerInstance {
  mainApp: Hono<any> | null;
  handlers: Map<string, AppHandler>;
}

/**
 * Central registry for all workers and their associated apps.
 * Provides service discovery and handler lookup capabilities.
 */
export class AppWorkerRegistry {
  private workers: Map<string, WorkerInstance> = new Map();

  // Register a worker's main app
  registerMainApp(workerName: string, app: Hono<any>): void {
    const instance = this.getOrCreateWorkerInstance(workerName);
    instance.mainApp = app;
  }

  // Register a handler within a worker
  registerHandler(workerName: string, handler: AppHandler): void {
    const instance = this.getOrCreateWorkerInstance(workerName);
    instance.handlers.set(handler.name, handler);
  }

  // Get a handler by name within a specific worker
  getHandler(workerName: string, handlerName: string): AppHandler | undefined {
    return this.workers.get(workerName)?.handlers.get(handlerName);
  }

  // Get handler by name across all workers
  findHandler(handlerName: string): { workerName: string; handler: AppHandler } | undefined {
    for (const [workerName, instance] of this.workers.entries()) {
      const handler = instance.handlers.get(handlerName);
      if (handler) {
        return { workerName, handler };
      }
    }
    return undefined;
  }

  // Get main app for a worker
  getMainApp(workerName: string): Hono<any> | undefined | null {
    return this.workers.get(workerName)?.mainApp;
  }

  // Get all handler names for a worker
  getHandlerNames(workerName: string): string[] {
    const instance = this.workers.get(workerName);
    if (!instance) return [];
    return Array.from(instance.handlers.keys());
  }

  // Get all registered worker names
  getWorkerNames(): string[] {
    return Array.from(this.workers.keys());
  }

  // Check if a handler exists in any worker
  hasHandler(handlerName: string): boolean {
    for (const instance of this.workers.values()) {
      if (instance.handlers.has(handlerName)) return true;
    }
    return false;
  }

  // Get all handlers across all workers
  getAllHandlers(): Map<string, AppHandler> {
    const allHandlers = new Map<string, AppHandler>();
    for (const instance of this.workers.values()) {
      for (const [name, handler] of instance.handlers.entries()) {
        allHandlers.set(name, handler);
      }
    }
    return allHandlers;
  }

  // Get all workers with their instance
  getAllWorkers(): Map<string, WorkerInstance> {
    return this.workers;
  }

  private getOrCreateWorkerInstance(workerName: string): WorkerInstance {
    let instance = this.workers.get(workerName);
    if (!instance) {
      instance = { mainApp: null, handlers: new Map() };
      this.workers.set(workerName, instance);
    }
    return instance;
  }

  // Reset registry (useful for testing)
  reset(): void {
    this.workers.clear();
  }
}

// Global singleton registry used by all workers in the same isolate
export const appWorkerRegistry = new AppWorkerRegistry();
