/** How long one registry or advisory request may take, headers and body together. A stalled server would otherwise hold a sweep with no sign. */
export const HTTP_TIMEOUT_MS = 60_000;

/**
 * Runs one request with a deadline. Bun's own 300 s limit is switched off (`timeout: false`) so this one is the only limit, and the signal
 * also covers the body, so a server that sends headers and then stalls ends the same way. Only a TimeoutError is reported as a timeout;
 * any other failure keeps its own message.
 */
export async function timed<T>(what: string, run: (init: RequestInit) => Promise<T>, ms = HTTP_TIMEOUT_MS): Promise<T> {
  try {
    return await run({ signal: AbortSignal.timeout(ms), timeout: false } as RequestInit);
  } catch (e) {
    if (e instanceof Error && e.name === "TimeoutError") throw new Error(`timed out after ${ms} ms: ${what}`);
    throw e;
  }
}
