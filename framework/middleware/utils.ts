export function nowMs(): number {
  return Date.now();
}

export function computeExpiryFromJwtPayload(payload: any, fallbackMs = 5 * 60 * 1000): number {
  if (payload && typeof payload.exp === 'number') {
    return payload.exp * 1000 - 30_000; // safety window
  }
  return nowMs() + fallbackMs;
}

export function toBase64(input: string): string {
  try {
    const btoaFn = (globalThis as any).btoa as ((s: string) => string) | undefined;
    if (typeof btoaFn === 'function') return btoaFn(input);
  } catch { }
  try {
    const BufferRef = (globalThis as any).Buffer as any;
    if (BufferRef?.from) return BufferRef.from(input).toString('base64');
  } catch { }
  // Minimal fallback
  const encoder = new TextEncoder();
  const bytes = encoder.encode(input);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  const btoaFn = (globalThis as any).btoa as (s: string) => string;
  return btoaFn(binary);
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  // crypto.subtle is available in Workers runtime
  const digest = await (crypto as any).subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

export function maskTokenLast(token: string, last: number = 6): string {
  if (!token || typeof token !== 'string') return '';
  const visible = Math.max(0, Math.min(last, token.length));
  return `...${token.slice(-visible)}`;
}
