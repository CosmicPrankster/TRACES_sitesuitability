/**
 * Small shared HTTP helper for site-data providers.
 *
 * Every provider must degrade gracefully: a failed lookup produces a
 * `no_data`/`error` report, never a fabricated value, and never an exception
 * that reaches the caller.
 */

export interface FetchJsonOptions {
  timeoutMs: number;
  userAgent: string;
  fetchImpl?: typeof fetch;
}

export interface FetchJsonResult<T> {
  ok: boolean;
  data?: T;
  status?: number;
  error?: string;
  url: string;
}

export async function fetchJson<T>(url: string, opts: FetchJsonOptions): Promise<FetchJsonResult<T>> {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    return { ok: false, error: "No fetch implementation available in this runtime.", url };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await doFetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": opts.userAgent,
      },
      // Site data is not user-specific; allow the platform to cache it briefly.
      cache: "no-store",
    });
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status} ${res.statusText}`, url };
    }
    const data = (await res.json()) as T;
    return { ok: true, data, status: res.status, url };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.name === "AbortError"
          ? `Timed out after ${opts.timeoutMs} ms`
          : err.message
        : String(err);
    return { ok: false, error: message, url };
  } finally {
    clearTimeout(timer);
  }
}

/** Great-circle distance in km, used to describe how far a station is. */
export function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
