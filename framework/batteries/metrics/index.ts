import * as v from 'valibot';
import { getWorkerMetricsConfig, loadConfig, serviceToBindingName } from '../../core/config';

export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';
const metricName = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const labelName = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export type MetricType = 'counter' | 'gauge';
export interface MetricSample { labels?: Record<string, string>; value: number; }
export interface MetricFamily { name: string; help: string; type: MetricType; samples: MetricSample[]; }
export interface MetricsCollectionContext { env: Record<string, unknown>; workerName: string; handlerName: string; request?: Request; }
export interface MetricsProvider { collect(context: MetricsCollectionContext): Promise<MetricFamily[]>; }

export const metricSampleSchema = v.object({ labels: v.optional(v.record(v.string(), v.string())), value: v.number() });
export const metricFamilySchema = v.object({ name: v.string(), help: v.string(), type: v.picklist(['counter', 'gauge']), samples: v.array(metricSampleSchema) });

export function parseMetricsDuration(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(value);
  if (!match) throw new Error(`Invalid metrics duration '${value}'`);
  const multipliers: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };
  return Number(match[1]) * multipliers[match[2]]!;
}

function escapeHelp(value: string): string { return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n'); }
function escapeLabel(value: string): string { return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"'); }
function sampleKey(labels: Record<string, string>): string { return Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join(','); }

export function validateMetricFamilies(families: MetricFamily[]): MetricFamily[] {
  for (const family of families) {
    v.parse(metricFamilySchema, family);
    if (!metricName.test(family.name)) throw new Error(`Invalid Prometheus metric name '${family.name}'`);
    for (const sample of family.samples) {
      if (!Number.isFinite(sample.value)) throw new Error(`Metric '${family.name}' has a non-finite value`);
      for (const label of Object.keys(sample.labels || {})) if (!labelName.test(label)) throw new Error(`Invalid Prometheus label name '${label}'`);
    }
  }
  return families;
}

export function addMetricLabels(families: MetricFamily[], labels: Record<string, string>): MetricFamily[] {
  return families.map((family) => ({ ...family, samples: family.samples.map((sample) => {
    const sampleLabels = sample.labels || {};
    for (const [key, value] of Object.entries(labels)) if (sampleLabels[key] !== undefined && sampleLabels[key] !== value) throw new Error(`Metric '${family.name}' label '${key}' conflicts with configured source label`);
    return { ...sample, labels: { ...labels, ...sampleLabels } };
  }) }));
}

export function mergeMetricFamilies(input: MetricFamily[][]): MetricFamily[] {
  const merged = new Map<string, MetricFamily>();
  const invalidFamilies = new Set<string>();
  const values = new Map<string, number>();
  const conflictedSamples = new Set<string>();
  for (const group of input) for (const family of validateMetricFamilies(group)) {
    const current = merged.get(family.name);
    if (!current) merged.set(family.name, { ...family, samples: [] });
    else if (current.help !== family.help || current.type !== family.type) { invalidFamilies.add(family.name); continue; }
    const destination = merged.get(family.name)!;
    for (const sample of family.samples) {
      const key = `${family.name}|${sampleKey(sample.labels || {})}`;
      if (conflictedSamples.has(key)) continue;
      const existing = values.get(key);
      if (existing === undefined) { values.set(key, sample.value); destination.samples.push({ ...sample, labels: { ...(sample.labels || {}) } }); }
      else if (existing !== sample.value) {
        conflictedSamples.add(key);
        values.delete(key);
        destination.samples = destination.samples.filter((entry) => sampleKey(entry.labels || {}) !== sampleKey(sample.labels || {}));
      }
    }
  }
  return [...merged.values()].filter((family) => !invalidFamilies.has(family.name)).sort((a, b) => a.name.localeCompare(b.name)).map((family) => ({ ...family, samples: [...family.samples].sort((a, b) => sampleKey(a.labels || {}).localeCompare(sampleKey(b.labels || {}))) }));
}

export function serializePrometheus(families: MetricFamily[]): string {
  const lines: string[] = [];
  for (const family of mergeMetricFamilies([families])) {
    lines.push(`# HELP ${family.name} ${escapeHelp(family.help)}`, `# TYPE ${family.name} ${family.type}`);
    for (const sample of family.samples) {
      const labels = sample.labels || {};
      const rendered = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(',');
      lines.push(`${family.name}${rendered ? `{${rendered}}` : ''} ${sample.value}`);
    }
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}

export interface MetricsSnapshot { collectedAt: number; families: MetricFamily[]; }
export interface MetricsLease { holder: string; expiresAt: number; }
export interface MetricsDurableEnv { [key: string]: unknown; }

type MetricsDurableStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
};

class MetricsDurableObjectBase {
  readonly ctx: { storage: MetricsDurableStorage };
  readonly env: MetricsDurableEnv;
  constructor(...args: [ctx: { storage: MetricsDurableStorage }, env: MetricsDurableEnv]) {
    [this.ctx, this.env] = args;
  }
}

// TypeScript mixins require an any[] constructor; runtime inputs remain the
// typed Durable Object state/environment pair defined above.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MetricsDurableObjectConstructor = new (...args: any[]) => MetricsDurableObjectBase;

/** Creates a cache class using the runtime DurableObject base supplied by the Worker entrypoint. */
export function createBobraMetricsCacheClass<TBase extends MetricsDurableObjectConstructor>(DurableObjectBase: TBase) {
return class BobraMetricsCache extends DurableObjectBase {
  async readSnapshot(key: string): Promise<MetricsSnapshot | undefined> { return this.ctx.storage.get<MetricsSnapshot>(`snapshot:${key}`); }
  async writeSnapshot(key: string, snapshot: MetricsSnapshot): Promise<void> { await this.ctx.storage.put(`snapshot:${key}`, snapshot); }
  async deleteSnapshot(key: string): Promise<void> { await this.ctx.storage.delete(`snapshot:${key}`); }
  async acquireLease(key: string, holder: string, ttlMs: number): Promise<boolean> {
    const leaseKey = `lease:${key}`;
    const current = await this.ctx.storage.get<MetricsLease>(leaseKey);
    const now = Date.now();
    if (current && current.expiresAt > now && current.holder !== holder) return false;
    await this.ctx.storage.put(leaseKey, { holder, expiresAt: now + ttlMs } satisfies MetricsLease);
    return true;
  }
  async releaseLease(key: string, holder: string): Promise<void> {
    const leaseKey = `lease:${key}`;
    const current = await this.ctx.storage.get<MetricsLease>(leaseKey);
    if (current?.holder === holder) await this.ctx.storage.delete(leaseKey);
  }
};
}

/** Coordinator owns the next alarm timestamp; application code performs collection through Service Bindings. */
export function createBobraMetricsCoordinatorClass<TBase extends MetricsDurableObjectConstructor>(DurableObjectBase: TBase) {
	const BobraMetricsCache = createBobraMetricsCacheClass(DurableObjectBase);
	return class BobraMetricsCoordinator extends BobraMetricsCache {
  async scheduleNext(at: number): Promise<void> { await this.ctx.storage.put('next_alarm_at', at); await this.ctx.storage.setAlarm(at); }
  async readMergedSnapshot(): Promise<MetricsSnapshot | undefined> { return this.readSnapshot('merged'); }
  async refresh(): Promise<MetricsSnapshot> {
    const config = await loadConfig(this.env);
    const workerName = Object.entries(config.workers).find(([, worker]) => worker.handlers.includes('observability'))?.[0] || String(this.env.WORKER_NAME || 'observability');
    const policy = config.workers[workerName] ? getWorkerMetricsConfig(config, workerName).cache : undefined;
    const holder = crypto.randomUUID();
    const leaseTtl = policy?.provider_timeout ? parseMetricsDuration(policy.provider_timeout) : 15_000;
    if (!await this.acquireLease('merged', holder, leaseTtl)) {
      const existing = await this.readMergedSnapshot();
      // A concurrent scrape must never turn a valid snapshot into a 503. If
      // one exists, keep serving it while the owner refreshes it. This avoids
      // series disappearing from Prometheus during normal single-flight work.
      if (existing) return existing;

      // First scrape after startup: wait briefly for the owner to publish the
      // initial complete snapshot, then return it. Do not fabricate metrics.
      const waitMs = policy?.provider_timeout ? parseMetricsDuration(policy.provider_timeout) : 15_000;
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const snapshot = await this.readMergedSnapshot();
        if (snapshot) return snapshot;
      }
      throw new Error('Metrics aggregation initial refresh timed out');
    }
    try {
      const result = await collectObservabilityMetricGroups({ env: this.env, workerName, handlerName: 'observability' });
      if (result.successfulProviders === 0) throw new Error('No metrics provider returned a successful response');
      if (result.successfulProviders < result.expectedProviders) {
        throw new Error(`Metrics collection incomplete: ${result.successfulProviders}/${result.expectedProviders} providers succeeded`);
      }
      const snapshot = { collectedAt: Date.now(), families: result.families } satisfies MetricsSnapshot;
      await this.writeSnapshot('merged', snapshot);
      return snapshot;
    } catch (error) {
      // Keep the last complete snapshot available during transient provider
      // failures. A scrape outage must not erase all Prometheus series.
      const existing = await this.readMergedSnapshot();
      if (existing) return existing;
      throw error;
    } finally {
      await this.releaseLease('merged', holder);
    }
  }
  async alarm(): Promise<void> {
    const config = await loadConfig(this.env);
    const workerName = Object.entries(config.workers).find(([, worker]) => worker.handlers.includes('observability'))?.[0] || String(this.env.WORKER_NAME || 'observability');
    const policy = config.workers[workerName] ? getWorkerMetricsConfig(config, workerName).cache : undefined;
    try { await this.refresh(); }
    finally {
      const delay = policy?.freshness ? parseMetricsDuration(policy.freshness) : 60_000;
      await this.scheduleNext(Date.now() + delay);
    }
  }
	};
}

// Node-safe classes for configuration/tests. Worker entrypoints must create
// their exports with cloudflare:workers DurableObject to enable RPC.
export class BobraMetricsCache extends createBobraMetricsCacheClass(MetricsDurableObjectBase) {}
export class BobraMetricsCoordinator extends createBobraMetricsCoordinatorClass(MetricsDurableObjectBase) {}

type InternalServiceBinding = { fetch(url: string, init?: RequestInit): Promise<Response> };

/** Provider for a normal `observability` handler. It performs one Service Binding call per participating Worker. */
export function createObservabilityMetricsProvider(): MetricsProvider {
  return {
    async collect(context): Promise<MetricFamily[]> {
      const result = await collectObservabilityMetricGroups(context);
      if (result.successfulProviders === 0) throw new Error('No metrics provider returned a successful response');
      return result.families;
    }
  };
}

export async function collectObservabilityMetricGroups(context: MetricsCollectionContext): Promise<{ families: MetricFamily[]; successfulProviders: number; expectedProviders: number }> {
      const config = await loadConfig(context.env);
      const groups: MetricFamily[][] = [];
      let successfulProviders = 0;
      const providers = Object.entries(config.workers).filter(([workerName, worker]) => workerName !== context.workerName && worker.metrics?.enabled);
      await Promise.all(providers.map(async ([workerName]) => {
        const binding = context.env[serviceToBindingName(workerName)] as InternalServiceBinding | undefined;
        if (!binding) return;
        const token = config.metrics?.internal_token_binding ? context.env[config.metrics.internal_token_binding] : undefined;
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (typeof token === 'string') headers['X-Internal-Token'] = token;
        const response = await binding.fetch('http://internal/_bobra/metrics/collect', { method: 'POST', headers, body: '{}' });
        if (!response.ok) return;
        const payload = await response.json() as { families?: MetricFamily[] };
        if (!payload.families) return;
        successfulProviders += 1;
        groups.push(payload.families);
      }));
      return { families: mergeMetricFamilies(groups), successfulProviders, expectedProviders: providers.length };
}
