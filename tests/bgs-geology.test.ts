import { describe, expect, it } from "vitest";
import { bgsGeologyProvider } from "@/lib/providers/bgs-geology";

/**
 * The BGS provider is exercised entirely against mocked responses, because the
 * point of these tests is the parsing and the inference - not the network.
 */

const CTX = { timeoutMs: 1000, userAgent: "test", latitude: 51.18, longitude: -0.76 };

const mock = (body: unknown, ok = true): typeof fetch =>
  (async () =>
    ({
      ok,
      status: ok ? 200 : 500,
      statusText: ok ? "OK" : "Server Error",
      json: async () => body,
    }) as Response) as unknown as typeof fetch;

describe("BGS geology lookup", () => {
  it("skips itself without coordinates rather than guessing", async () => {
    const f = await bgsGeologyProvider.getSiteData("x", { timeoutMs: 500, userAgent: "t" });
    expect(f.report.status).toBe("skipped");
    expect(f.data).toBeUndefined();
  });

  it("reads superficial deposits in preference to bedrock", async () => {
    const f = await bgsGeologyProvider.getSiteData("x", {
      ...CTX,
      fetchImpl: mock({
        results: [
          {
            layerName: "BGS Bedrock Geology",
            attributes: { LEX_D: "Gault Formation", RCS_D: "Mudstone" },
          },
          {
            layerName: "BGS Superficial Deposits",
            attributes: { LEX_D: "River Terrace Deposits", RCS_D: "Sand and Gravel" },
          },
        ],
      }),
    });

    expect(f.report.status).toBe("ok");
    // Superficial wins: it is what the catchment actually sheds.
    expect(f.particleCharacter).toBe("sand");
    expect(f.data?.[0].parameter).toBe("Superficial deposits");
    expect(f.data?.[0].value).toMatch(/River Terrace Deposits/);
    expect(f.data?.[0].provenance).toBe("published");
  });

  it("maps lithology to a solids character, and labels it an inference", async () => {
    const cases: [string, string][] = [
      ["Clay", "clay"],
      ["Silt and Alluvium", "silt"],
      ["Sandstone", "sand"],
      ["Chalk", "mixed_mineral"],
      ["Peat", "organic"],
    ];
    for (const [lithology, expected] of cases) {
      const f = await bgsGeologyProvider.getSiteData("x", {
        ...CTX,
        fetchImpl: mock({
          results: [{ layerName: "Superficial", attributes: { RCS_D: lithology, LEX_D: "Unit" } }],
        }),
      });
      expect(f.particleCharacter).toBe(expected);
      expect(f.particleCharacterProvenance).toBe("inferred");
      expect(f.particleCharacterBasis).toMatch(/INFERENCE/);
      // It must not overstate: geology is not a measurement of the water.
      expect(f.particleCharacterBasis).toMatch(/not a measurement of the water/i);
      expect(f.particleCharacterBasis).toMatch(/finer than the material/i);
    }
  });

  it("records geology but infers nothing when the lithology is unrecognised", async () => {
    const f = await bgsGeologyProvider.getSiteData("x", {
      ...CTX,
      fetchImpl: mock({
        results: [{ layerName: "Superficial", attributes: { RCS_D: "Xenolithic breccia", LEX_D: "Odd" } }],
      }),
    });
    expect(f.report.status).toBe("ok");
    expect(f.data?.length).toBe(1);
    expect(f.particleCharacter).toBeUndefined();
    expect(f.geologyNotes?.join(" ")).toMatch(/not used to characterise/i);
  });

  it("reports the attribute keys it saw when it cannot parse the response", async () => {
    const f = await bgsGeologyProvider.getSiteData("x", {
      ...CTX,
      fetchImpl: mock({ results: [{ layerName: "Something", attributes: { WEIRD_KEY: "value" } }] }),
    });
    expect(f.report.status).toBe("no_data");
    // The message must tell you exactly how to fix it.
    expect(f.report.message).toMatch(/WEIRD_KEY/);
    expect(f.report.message).toMatch(/ATTRIBUTE_KEYS/);
    expect(f.particleCharacter).toBeUndefined();
  });

  it("returns no_data outside Great Britain rather than an error", async () => {
    const f = await bgsGeologyProvider.getSiteData("x", {
      ...CTX,
      fetchImpl: mock({ results: [] }),
    });
    expect(f.report.status).toBe("no_data");
    expect(f.report.message).toMatch(/outside Great Britain/i);
  });

  it("degrades to an error report, never an exception, when the service fails", async () => {
    const f = await bgsGeologyProvider.getSiteData("x", {
      ...CTX,
      fetchImpl: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
    });
    expect(f.report.status).toBe("error");
    expect(f.report.message).toMatch(/BGS_MAPSERVER_URL/);
    expect(f.data).toBeUndefined();
  });
});
