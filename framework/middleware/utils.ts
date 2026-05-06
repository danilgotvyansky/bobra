export function nowMs(): number {
  return Date.now();
}

type JwtPayloadLike = { exp?: number } | Record<string, unknown> | null | undefined;

interface GlobalBase64Support {
  btoa?: (input: string) => string;
  Buffer?: {
    from: (input: string) => { toString: (encoding: string) => string };
  };
}

export function computeExpiryFromJwtPayload(payload: JwtPayloadLike, fallbackMs = 5 * 60 * 1000): number {
  if (payload && typeof payload === 'object' && 'exp' in payload && typeof payload.exp === 'number') {
    return payload.exp * 1000 - 30_000; // safety window
  }
  return nowMs() + fallbackMs;
}

export function toBase64(input: string): string {
  const globals = globalThis as typeof globalThis & GlobalBase64Support;

  try {
    const btoaFn = globals.btoa;
    if (typeof btoaFn === 'function') return btoaFn(input);
  } catch { }

  try {
    const bufferRef = globals.Buffer;
    if (bufferRef?.from) return bufferRef.from(input).toString('base64');
  } catch { }

  // Minimal fallback
  const encoder = new TextEncoder();
  const bytes = encoder.encode(input);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);

  const fallbackBtoa = globals.btoa;
  if (typeof fallbackBtoa === 'function') {
    return fallbackBtoa(binary);
  }

  throw new Error('No Base64 encoder available in current runtime');
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  // crypto.subtle is available in Workers runtime
  const digest = await crypto.subtle.digest('SHA-256', data);
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
