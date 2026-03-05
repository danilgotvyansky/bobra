export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  SILENT = 4
}

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  context?: string;
  worker?: string;
  handler?: string;
  metadata?: Record<string, any>;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

export interface LoggerConfig {
  level: LogLevel;
  format: 'json' | 'text';
  includeTimestamp: boolean;
  includeContext: boolean;
  colorize: boolean;
  // TEMP WORKAROUND: route DEBUG via console.info to avoid Wrangler dev filtering of console.debug
  // Remove once https://github.com/cloudflare/workers-sdk/issues/10690 is fixed and wrangler dev
  // supports separate app vs tool log levels.
  debugSink?: 'debug' | 'info';
  startupVerbosity?: string[];
  logRequestBody?: boolean;
  logResponseBody?: boolean;
  logIncomingRequest?: boolean;
  logHeaders?: boolean;
}

const SENSITIVE_KEYS = ['password', 'token', 'secret', 'authorization', 'key', 'auth', 'cookie', 'credential', 'access_token', 'refresh_token'];
const BEARER_REGEX = /(Bearer\s+)([a-zA-Z0-9\-_.]+)/gi;

function sanitize(obj: any): any {
  if (!obj) return obj;

  if (typeof obj === 'string') {
    // Redact Bearer tokens from string content
    return obj.replace(BEARER_REGEX, '$1***');
  }

  if (Array.isArray(obj)) {
    return obj.map(sanitize);
  }

  if (typeof obj === 'object') {
    const newObj: any = {};
    for (const key in obj) {
      const lowerKey = key.toLowerCase();
      if (SENSITIVE_KEYS.some(k => lowerKey.includes(k))) {
        newObj[key] = '***';
      } else {
        newObj[key] = sanitize(obj[key]);
      }
    }
    return newObj;
  }

  return obj;
}

export class AppLogger {
  private config: LoggerConfig;
  private context?: string;
  private worker?: string;
  private handler?: string;
  private readonly colors = {
    debug: '\x1b[36m',    // Cyan
    info: '\x1b[32m',     // Green
    warn: '\x1b[33m',     // Yellow
    error: '\x1b[31m',    // Red
    reset: '\x1b[0m'      // Reset
  };

  constructor(config: LoggerConfig, context?: string, worker?: string, handler?: string) {
    this.config = config;
    this.context = context;
    this.worker = worker;
    this.handler = handler;
  }

  // Create a child logger with additional context
  child(context: string, handler?: string): AppLogger {
    return new AppLogger(this.config, context, this.worker, handler);
  }

  // Set worker context
  setWorker(worker: string): AppLogger {
    this.worker = worker;
    return this;
  }

  // Set handler context
  setHandler(handler: string): AppLogger {
    this.handler = handler;
    return this;
  }

  private shouldLog(level: LogLevel): boolean {
    return level >= this.config.level;
  }

  private formatMessage(level: LogLevel, message: string, metadata?: Record<string, any>, error?: Error): string {
    const levelName = LogLevel[level].toLowerCase();
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: levelName,
      message,
      context: this.context,
      worker: this.worker,
      handler: this.handler,
      metadata: sanitize(metadata),
      error: error ? {
        name: error.name,
        message: error.message,
        stack: error.stack
      } : undefined
    };

    if (this.config.format === 'json') {
      return JSON.stringify(entry);
    }

    // Text format
    let formatted = '';

    if (this.config.includeTimestamp) {
      formatted += `[${entry.timestamp}] `;
    }

    const levelStr = levelName.toUpperCase().padEnd(5);
    if (this.config.colorize) {
      formatted += `${this.colors[levelName as keyof typeof this.colors]}${levelStr}${this.colors.reset} `;
    } else {
      formatted += `${levelStr} `;
    }

    if (this.config.includeContext) {
      const contextParts = [];
      if (this.worker) contextParts.push(`worker:${this.worker}`);
      if (this.handler) contextParts.push(`handler:${this.handler}`);
      if (this.context) contextParts.push(`ctx:${this.context}`);

      if (contextParts.length > 0) {
        formatted += `[${contextParts.join(',')}] `;
      }
    }

    formatted += sanitize(message);

    if (entry.metadata && Object.keys(entry.metadata).length > 0) {
      formatted += ` ${JSON.stringify(entry.metadata)}`;
    }

    if (error) {
      formatted += `\n  Error: ${error.name}: ${error.message}`;
      if (error.stack) {
        formatted += `\n  Stack: ${error.stack}`;
      }
    }

    return formatted;
  }

  debug(message: string, metadata?: Record<string, any>): void {
    if (!this.shouldLog(LogLevel.DEBUG)) return;
    const sink = this.config.debugSink === 'info' ? 'info' : 'debug';
    console[sink](this.formatMessage(LogLevel.DEBUG, message, metadata));
  }

  info(message: string, metadata?: Record<string, any>): void {
    if (!this.shouldLog(LogLevel.INFO)) return;
    console.info(this.formatMessage(LogLevel.INFO, message, metadata));
  }

  warn(message: string, metadata?: Record<string, any>): void {
    if (!this.shouldLog(LogLevel.WARN)) return;
    console.warn(this.formatMessage(LogLevel.WARN, message, metadata));
  }

  error(message: string, error?: Error, metadata?: Record<string, any>): void {
    if (!this.shouldLog(LogLevel.ERROR)) return;
    console.error(this.formatMessage(LogLevel.ERROR, message, metadata, error));
  }

  // HTTP request logging
  request(method: string, path: string, status?: number, duration?: number, metadata?: Record<string, any>): void {
    if (!this.shouldLog(LogLevel.INFO)) return;

    const logMetadata = {
      method,
      path,
      status,
      duration: duration ? `${duration}ms` : undefined,
      ...metadata
    };

    let message = `${method} ${path}`;
    if (status !== undefined) {
      message += ` ${status}`;
    }
    if (duration !== undefined) {
      message += ` ${duration}ms`;
    }

    this.info(message, logMetadata);
  }

  // Get logger configuration
  getConfig(): LoggerConfig {
    return { ...this.config };
  }
}

// Default logger configuration
export const defaultLoggerConfig: LoggerConfig = {
  level: LogLevel.INFO,
  format: 'text',
  includeTimestamp: true,
  includeContext: true,
  colorize: true,
  debugSink: 'debug',
  startupVerbosity: ['worker-registry', 'discovery-validation', 'handler-add', 'handler-init'],
  logRequestBody: false,
  logResponseBody: false,
  logIncomingRequest: false,
  logHeaders: false
};

// Global logger instance
let globalLogger: AppLogger | null = null;

// Initialize global logger
export function initializeLogger(config: Partial<LoggerConfig> = {}, context?: string, worker?: string): AppLogger {
  const mergedConfig = { ...defaultLoggerConfig, ...config };
  globalLogger = new AppLogger(mergedConfig, context, worker);
  return globalLogger;
}

// Get global logger instance
export function getLogger(): AppLogger {
  if (!globalLogger) {
    globalLogger = new AppLogger(defaultLoggerConfig);
  }
  return globalLogger;
}

// Utility to serialize Error objects
export function serializeError(error: unknown): Record<string, any> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { message: String(error) };
}

// Convenience functions for global logger
export const logger = {
  debug: (message: string, metadata?: Record<string, any>) => getLogger().debug(message, metadata),
  info: (message: string, metadata?: Record<string, any>) => getLogger().info(message, metadata),
  warn: (message: string, metadata?: Record<string, any>) => getLogger().warn(message, metadata),
  error: (message: string, error?: Error, metadata?: Record<string, any>) => getLogger().error(message, error, metadata),
  request: (method: string, path: string, status?: number, duration?: number, metadata?: Record<string, any>) =>
    getLogger().request(method, path, status, duration, metadata),
  child: (context: string, handler?: string) => getLogger().child(context, handler),
  setWorker: (worker: string) => getLogger().setWorker(worker),
  setHandler: (handler: string) => getLogger().setHandler(handler)
};

/**
 * LogStack allows grouping multiple log messages into a single log entry.
 * Useful for reducing log volume during initialization or batch processing.
 */
export class LogStack {
  private messages: Array<{ message: string; metadata?: Record<string, any> }> = [];
  private logger: AppLogger;

  constructor(logger?: AppLogger) {
    this.logger = logger || getLogger();
  }

  /**
   * Add a message to the stack
   */
  add(message: string, metadata?: Record<string, any>): void {
    this.messages.push({ message, metadata });
  }

  /**
   * Flush the stack as a single log message
   * @param level The log level to use
   * @param summary The summary message for the log entry
   */
  flush(level: LogLevel, summary: string): void {
    if (this.messages.length === 0) return;

    const metadata = {
      count: this.messages.length,
      stack: this.messages
    };

    switch (level) {
      case LogLevel.DEBUG:
        this.logger.debug(summary, metadata);
        break;
      case LogLevel.INFO:
        this.logger.info(summary, metadata);
        break;
      case LogLevel.WARN:
        this.logger.warn(summary, metadata);
        break;
      case LogLevel.ERROR:
        this.logger.error(summary, undefined, metadata);
        break;
    }

    this.clear();
  }

  /**
   * Clear the stack without logging
   */
  clear(): void {
    this.messages = [];
  }

  /**
   * Get current message count
   */
  get count(): number {
    return this.messages.length;
  }
}
