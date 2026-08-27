import type { SiteDatum, SiteDataFragment, SiteDataProvider, SiteLookupContext } from "@/types";
import { fetchJson, haversineKm } from "./http";

/**
 * Environment Agency Water Quality Archive (England, open, no key).
 * https://environment.data.gov.uk/water-quality/view/doc/reference
 *
 * This is the most directly relevant public source for the screening: it holds
 * historical suspended-solids and turbidity measurements at sampling points.
 *
 * Important limitation, which the report states explicitly: a suspended-solids
 * concentration tells you HOW MUCH solid material is present. It says nothing
 * about the PARTICLE SIZE, which is what determines whether a hydrocyclone can
 * remove it. Concentration alone therefore cannot resolve the matrix.
 */

const SP_BASE = "https://environment.data.gov.uk/water-quality/id/sampling-point";
const MEAS_BASE = "https://environment.data.gov.uk/water-quality/data/measurement";
const SEARCH_RADIUS_KM = 8;

/** Water Quality Archive determinand notations. */
const DETERMINANDS = [
  { notation: "0135", label: "Suspended solids (dried at 105 C)" },
  { notation: "0076", label: "Turbidity" },
];

interface SamplingPoint {
  "@id"?: string;
  notation?: string;
  label?: string;
  lat?: number;
  long?: number;
  samplingPointType?: { label?: string };
}

interface Measurement {
  result?: number;
  resultQualifier?: { notation?: string };
  determinand?: { label?: string; notation?: string; unit?: { label?: string } };
  sample?: { sampleDateTime?: string; samplingPoint?: { label?: string } };
}

export const eaWaterQualityProvider: SiteDataProvider = {
  id: "ea-water-quality",
  name: "Environment Agency Water Quality Archive (England)",

  async getSiteData(_location: string, ctx: SiteLookupContext): Promise<SiteDataFragment> {
    const started = Date.now();

    if (ctx.latitude === undefined || ctx.longitude === undefined) {
      return {
        report: {
          providerId: "ea-water-quality",
          providerName: eaWaterQualityProvider.name,
          status: "skipped",
          message: "Skipped: no coordinates were available for a radial sampling-point search.",
          durationMs: Date.now() - started,
        },
      };
    }

    const opts = { timeoutMs: ctx.timeoutMs, userAgent: ctx.userAgent, fetchImpl: ctx.fetchImpl };

    const spUrl =
      `${SP_BASE}?lat=${ctx.latitude}&long=${ctx.longitude}&dist=${SEARCH_RADIUS_KM}&_limit=30`;
    const sp = await fetchJson<{ items?: SamplingPoint[] }>(spUrl, opts);

    if (!sp.ok) {
      return {
        report: {
          providerId: "ea-water-quality",
          providerName: eaWaterQualityProvider.name,
          status: "error",
          message: `Lookup failed: ${sp.error}`,
          sourceUrl: spUrl,
          durationMs: Date.now() - started,
        },
        unknowns: ["Historical suspended-solids data could not be retrieved."],
      };
    }

    const points = (sp.data?.items ?? [])
      .filter((p) => typeof p.lat === "number" && typeof p.long === "number" && p.notation)
      .map((p) => ({
        p,
        km: haversineKm(ctx.latitude!, ctx.longitude!, p.lat as number, p.long as number),
      }))
      .sort((a, b) => a.km - b.km)
      .slice(0, 3);

    if (points.length === 0) {
      return {
        report: {
          providerId: "ea-water-quality",
          providerName: eaWaterQualityProvider.name,
          status: "no_data",
          message: `No water-quality sampling point within ${SEARCH_RADIUS_KM} km.`,
          sourceUrl: spUrl,
          durationMs: Date.now() - started,
        },
        unknowns: [
          "No nearby Environment Agency water-quality sampling point, so no historical " +
            "suspended-solids or turbidity record is available.",
        ],
      };
    }

    const data: SiteDatum[] = [];
    const unknowns: string[] = [];

    for (const det of DETERMINANDS) {
      const collected: { value: number; unit?: string; date?: string; point: string; url: string }[] = [];

      for (const { p, km } of points) {
        const url =
          `${MEAS_BASE}.json?samplingPoint=${encodeURIComponent(p.notation as string)}` +
          `&determinand=${det.notation}&_limit=60&_sort=-sample.sampleDateTime`;
        const res = await fetchJson<{ items?: Measurement[] }>(url, opts);
        if (!res.ok) continue;
        for (const m of res.data?.items ?? []) {
          // "<" qualifiers mean below the limit of detection: not a measured value.
          if (m.resultQualifier?.notation === "<") continue;
          if (typeof m.result !== "number") continue;
          collected.push({
            value: m.result,
            unit: m.determinand?.unit?.label,
            date: m.sample?.sampleDateTime,
            point: `${p.label ?? p.notation} (${km.toFixed(1)} km)`,
            url,
          });
        }
        if (collected.length >= 20) break;
      }

      if (collected.length === 0) {
        unknowns.push(`No ${det.label.toLowerCase()} measurements were found near this location.`);
        continue;
      }

      const values = collected.map((c) => c.value).sort((a, b) => a - b);
      const median = values[Math.floor(values.length / 2)];
      const p90 = values[Math.min(values.length - 1, Math.floor(values.length * 0.9))];
      const unit = collected.find((c) => c.unit)?.unit ?? "";
      const dates = collected.map((c) => c.date).filter(Boolean).sort() as string[];
      const nearest = collected[0];

      data.push({
        parameter: `${det.label} - median of ${values.length} archived samples`,
        value: Number(median.toFixed(2)),
        unit,
        provenance: "measured",
        confidence: "medium",
        source: `Environment Agency Water Quality Archive, sampling point ${nearest.point}`,
        sourceUrl: nearest.url,
        date: dates.length ? `${dates[0].slice(0, 10)} to ${dates[dates.length - 1].slice(0, 10)}` : undefined,
        notes:
          `90th percentile ${p90.toFixed(2)} ${unit}. Spot samples, not continuous monitoring, ` +
          "and taken at the archive's sampling point rather than at an abstraction point. " +
          (det.notation === "0135"
            ? "Concentration indicates HOW MUCH solid material is present. It does not indicate " +
              "PARTICLE SIZE, which is what governs whether a hydrocyclone can remove it."
            : "Turbidity responds most strongly to fine particles, so a high turbidity with a low " +
              "suspended-solids mass suggests a fine-dominated population."),
      });
    }

    if (data.length === 0) {
      return {
        report: {
          providerId: "ea-water-quality",
          providerName: eaWaterQualityProvider.name,
          status: "no_data",
          message: "Sampling points were found, but none held usable suspended-solids or turbidity results.",
          sourceUrl: spUrl,
          durationMs: Date.now() - started,
        },
        unknowns,
      };
    }

    return {
      report: {
        providerId: "ea-water-quality",
        providerName: eaWaterQualityProvider.name,
        status: "ok",
        message: `Retrieved ${data.length} summarised determinand(s) from up to ${points.length} sampling point(s).`,
        sourceUrl: spUrl,
        durationMs: Date.now() - started,
      },
      data,
      unknowns,
    };
  },
};
