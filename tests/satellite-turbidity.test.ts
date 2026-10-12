import { describe, expect, it } from "vitest";
import {
  buildStatisticsRequestBody,
  parseStatisticsResponse,
  toWebMercator,
  type SentinelStatisticsResponse,
} from "@/lib/sources/satellite-turbidity";

/**
 * The real response body captured live for "Tilford, River Wey"
 * (51.154565, -0.791587), 2026-10-12 - the v3 request shape, the one that
 * finally returned HTTP 200 after v1 (pixel-size error) and v2 (missing
 * dataMask output). See HANDOFF.md for the full probe history.
 */
const REAL_RESPONSE: SentinelStatisticsResponse = {
  data: [
    {
      interval: { from: "2026-09-12T00:00:00Z", to: "2026-10-12T00:00:00Z" },
      outputs: {
        data: {
          bands: {
            B0: {
              stats: {
                min: -0.8180330991744995,
                max: 0.31965264678001404,
                mean: -0.049179652171188734,
                stDev: 0.1322775064695323,
                sampleCount: 48400,
                noDataCount: 0,
              },
            },
          },
        },
      },
    },
  ],
  status: "OK",
};

describe("toWebMercator", () => {
  it("matches the real centre point computed for the Tilford probe (center.x ~ -88119, center.y ~ 6648680)", () => {
    const m = toWebMercator(-0.791587, 51.154565);
    expect(m.x).toBeCloseTo(-88119.06, 1);
    expect(m.y).toBeCloseTo(6648680.16, 1);
  });

  it("the equator and prime meridian map to the origin", () => {
    const m = toWebMercator(0, 0);
    expect(m.x).toBeCloseTo(0, 6);
    expect(m.y).toBeCloseTo(0, 6);
  });
});

describe("buildStatisticsRequestBody: the proven v3 shape", () => {
  const body = buildStatisticsRequestBody(-88119, 6648680, new Date("2026-09-12T00:00:00Z"), new Date("2026-10-12T00:00:00Z"));

  it("bbox is in EPSG:3857 (the v1->v2 fix)", () => {
    expect(body.input.bounds.properties.crs).toBe("http://www.opengis.net/def/crs/EPSG/0/3857");
    expect(body.input.bounds.bbox).toEqual([-89219, 6647580, -87019, 6649780]);
  });

  it("the evalscript declares an explicit dataMask OUTPUT, not just an input (the v2->v3 fix)", () => {
    expect(body.aggregation.evalscript).toMatch(/output:\s*\[/);
    expect(body.aggregation.evalscript).toMatch(/id:\s*"dataMask"/);
    expect(body.aggregation.evalscript).toMatch(/dataMask:\s*\[s\.dataMask\]/);
  });

  it("resx/resy are 10 metres, meaningful now the bbox is in a metres-based CRS", () => {
    expect(body.aggregation.resx).toBe(10);
    expect(body.aggregation.resy).toBe(10);
  });

  it("aggregates over a 30-day window, matching Sentinel-2's cloud-dependent revisit time", () => {
    expect(body.aggregation.aggregationInterval.of).toBe("P30D");
  });
});

describe("parseStatisticsResponse: the real captured Tilford response", () => {
  it("extracts the real NDTI stats", () => {
    const result = parseStatisticsResponse(REAL_RESPONSE)!;
    expect(result.ndtiMean).toBeCloseTo(-0.0492, 3);
    expect(result.sampleCount).toBe(48400);
    expect(result.noDataCount).toBe(0);
    expect(result.windowFrom).toBe("2026-09-12T00:00:00Z");
    expect(result.windowTo).toBe("2026-10-12T00:00:00Z");
  });

  it("the reasoning names the box size, the window, and the real sample count", () => {
    const result = parseStatisticsResponse(REAL_RESPONSE)!;
    expect(result.reasoning).toMatch(/2\.2 km/);
    expect(result.reasoning).toMatch(/48400 of 48400/);
    expect(result.reasoning).toMatch(/100%/);
  });

  it("the reasoning explicitly says NDTI is relative, not a concentration", () => {
    const result = parseStatisticsResponse(REAL_RESPONSE)!;
    expect(result.reasoning).toMatch(/RELATIVE index, not a measured concentration/);
  });

  it("the reasoning warns this is an area average, not a point reading", () => {
    const result = parseStatisticsResponse(REAL_RESPONSE)!;
    expect(result.reasoning).toMatch(/averages across the whole box/);
  });

  it("returns null for a response with zero valid pixels - insufficient data, not a guessed reading", () => {
    const empty: SentinelStatisticsResponse = {
      data: [
        {
          interval: { from: "2026-09-12T00:00:00Z", to: "2026-10-12T00:00:00Z" },
          outputs: { data: { bands: { B0: { stats: { min: 0, max: 0, mean: 0, stDev: 0, sampleCount: 0, noDataCount: 48400 } } } } },
        },
      ],
      status: "OK",
    };
    expect(parseStatisticsResponse(empty)).toBeNull();
  });

  it("returns null for a response with no data interval at all", () => {
    expect(parseStatisticsResponse({ data: [], status: "OK" })).toBeNull();
  });

  it("reports a partial cloud-free fraction honestly when noDataCount is nonzero", () => {
    const partial: SentinelStatisticsResponse = {
      data: [
        {
          interval: { from: "2026-09-12T00:00:00Z", to: "2026-10-12T00:00:00Z" },
          outputs: { data: { bands: { B0: { stats: { min: -0.5, max: 0.2, mean: -0.1, stDev: 0.1, sampleCount: 24200, noDataCount: 24200 } } } } },
        },
      ],
      status: "OK",
    };
    const result = parseStatisticsResponse(partial)!;
    expect(result.reasoning).toMatch(/24200 of 48400/);
    expect(result.reasoning).toMatch(/50%/);
  });
});
