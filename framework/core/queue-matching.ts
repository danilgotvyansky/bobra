export type QueueMatcher = (queueName: string, configuredQueues: string[]) => boolean;

export function buildQueueMatcher(pattern: RegExp, defaultBase: string): QueueMatcher {
  return (queueName: string, configuredQueues: string[]): boolean => {
    const base = (queueName || '').toLowerCase().replace(/-dlq$/i, '');
    const configuredBases = Array.isArray(configuredQueues)
      ? configuredQueues.map(q => (q || '').toLowerCase().replace(/-dlq$/i, ''))
      : [];
    // Only treat as config match if THIS base is present AND matches the pattern domain
    const inConfigBase = configuredBases.includes(base) && pattern.test(base);
    return inConfigBase || pattern.test(base) || base === defaultBase.toLowerCase();
  };
}
