const TOKEN_KEY = 'crosscode.gateway.jwt';

/** Persisted pairing JWT storage (fails soft in sandboxed contexts). */
export function getStoredToken(): string | null {
  try {
    return globalThis.localStorage?.getItem(TOKEN_KEY) ?? null;
  } catch {
    return null;
  }
}

export function setStoredToken(token: string): void {
  try {
    globalThis.localStorage?.setItem(TOKEN_KEY, token);
  } catch {
    // storage unavailable (private mode etc.) — session-only pairing
  }
}

export function clearStoredToken(): void {
  try {
    globalThis.localStorage?.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
}
