import { describe, expect, it } from "vitest";
import { geocodeProvider } from "@/lib/providers/geocode";

/**
 * Geocoding is the most load-bearing provider in the application: everything
 * else needs coordinates, so if it fails every site collapses to the same
 * default matrix. These tests pin the fallback behaviour that stops one
 * refusing backend taking the whole app down with it.
 */

const CTX = { timeoutMs: 1000, userAgent: "test" };

/** Responds per-URL, so each backend can be made to succeed or fail. */
function router(handlers: { match: string; body?: unknown; status?: number }[]): typeof fetch {
  return (async (url: string) => {
    const h = handlers.find((x) => String(url).includes(x.match));
    if (!h || h.status) {
      return {
        ok: false,
        status: h?.status ?? 500,
        statusText: "Error",
        json: async () => ({}),
      } as Response;
    }
    return { ok: true, status: 200, statusText: "OK", json: async () => h.body } as Response;
  }) as unknown as typeof fetch;
}

const openMeteoHit = {
  match: "geocoding-api.open-meteo.com",
  body: { results: [{ name: "Battersea", latitude: 51.47, longitude: -0.15, country: "United Kingdom" }] },
};
const nominatimHit = {
  match: "nominatim.openstreetmap.org",
  body: [{ lat: "51.47", lon: "-0.15", display_name: "Battersea, London", address: { country: "UK" } }],
};

describe("geocoding fallback", () => {
  it("resolves via the first backend when it works", async () => {
    const f = await geocodeProvider.getSiteData("Battersea", {
      ...CTX,
      fetchImpl: router([openMeteoHit, nominatimHit]),
    });
    expect(f.report.status).toBe("ok");
    expect(f.latitude).toBeCloseTo(51.47, 2);
    expect(f.report.message).toMatch(/Open-Meteo/);
  });

  it("falls through to Nominatim when the first backend fails", async () => {
    const f = await geocodeProvider.getSiteData("Battersea", {
      ...CTX,
      fetchImpl: router([{ match: "open-meteo", status: 500 }, nominatimHit]),
    });
    expect(f.report.status).toBe("ok");
    expect(f.report.message).toMatch(/Nominatim/);
    expect(f.latitude).toBeCloseTo(51.47, 2);
  });

  it("shortens the query when the full phrase does not match", async () => {
    // "Kinness Burn, St Andrews" fails; "St Andrews" succeeds.
    let seen: string[] = [];
    const impl = (async (url: string) => {
      seen.push(String(url));
      const ok = String(url).includes("St%20Andrews") && !String(url).includes("Kinness");
      return {
        ok,
        status: ok ? 200 : 404,
        statusText: ok ? "OK" : "Not Found",
        json: async () =>
          ok ? { results: [{ name: "St Andrews", latitude: 56.34, longitude: -2.79 }] } : {},
      } as Response;
    }) as unknown as typeof fetch;

    const f = await geocodeProvider.getSiteData("Kinness Burn, St Andrews", { ...CTX, fetchImpl: impl });
    expect(f.report.status).toBe("ok");
    expect(f.latitude).toBeCloseTo(56.34, 2);
    // It says plainly that it had to shorten the query.
    expect(f.report.message).toMatch(/shortened/i);
    expect(seen.some((u) => u.includes("Kinness"))).toBe(true);
  });

  it("explains the consequence when every backend fails", async () => {
    const f = await geocodeProvider.getSiteData("Nowhere at all", {
      ...CTX,
      fetchImpl: router([]),
    });
    expect(f.report.status).toBe("error");
    // The message must name the knock-on effect, not just the failure.
    expect(f.report.message).toMatch(/river gauges, water quality, geology\) was skipped/i);
    expect(f.report.message).toMatch(/every location-based lookup/i);
    expect(f.latitude).toBeUndefined();
  });

  it("names the User-Agent problem when Nominatim returns 403", async () => {
    const f = await geocodeProvider.getSiteData("Somewhere", {
      ...CTX,
      fetchImpl: router([
        { match: "open-meteo", status: 500 },
        { match: "nominatim", status: 403 },
      ]),
    });
    expect(f.report.status).toBe("error");
    expect(f.report.message).toMatch(/SITE_DATA_USER_AGENT/);
  });

  it("reports a rate limit as such", async () => {
    const f = await geocodeProvider.getSiteData("Somewhere", {
      ...CTX,
      fetchImpl: router([
        { match: "open-meteo", status: 500 },
        { match: "nominatim", status: 429 },
      ]),
    });
    expect(f.report.message).toMatch(/rate limited/i);
  });
});
