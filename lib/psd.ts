import type { Confidence, PSD, PSDBand, PSDPoint, PSDStatistics, Provenance } from "@/types";

/**
 * Deterministic particle-size-distribution maths.
 *
 * Two input forms are supported:
 *
 *  - `kind: "table"`      a list of (size, cumulative % passing) points. Values
 *                         between points are interpolated linearly in log(size);
 *                         outside the tabulated range the curve is clamped.
 *  - `kind: "percentiles"` D10 / D50 / D90 shorthand, fitted to a log-normal
 *                         distribution. This is a modelling choice and is
 *                         reported as such.
 *
 * Nothing here guesses at data. If the caller supplies only a D50, the fit
 * needs a spread and the caller must accept the documented default, which is
 * surfaced in the returned `notes`.
 */

/** Spread used when a distribution supplies D50 only. Reported as an assumption. */
export const DEFAULT_GEOMETRIC_STD_DEV = 3.0;

/** z-score of the 90th percentile of the standard normal; -z is the 10th. */
const Z90 = 1.2815515655446004;

/* -------------------------------------------------------------------------- */
/* Statistical helpers                                                         */
/* -------------------------------------------------------------------------- */

/** Abramowitz & Stegun 7.1.26 rational approximation to erf. |err| < 1.5e-7. */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

/** Standard normal cumulative distribution function. */
export function normCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/**
 * Inverse standard normal CDF (Acklam's rational approximation).
 * Accurate to about 1.15e-9 over the open interval (0, 1).
 */
export function normInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;

  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p > pHigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return (
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
}

/* -------------------------------------------------------------------------- */
/* PSD construction                                                            */
/* -------------------------------------------------------------------------- */

export interface PercentileInput {
  d10Um?: number;
  d50Um: number;
  d90Um?: number;
  label: string;
  provenance: Provenance;
  confidence: Confidence;
  source?: string;
  sourceUrl?: string;
  date?: string;
  verified?: boolean;
  notes?: string[];
}

export function psdFromPercentiles(input: PercentileInput): PSD {
  return {
    kind: "percentiles",
    label: input.label,
    d10Um: input.d10Um,
    d50Um: input.d50Um,
    d90Um: input.d90Um,
    provenance: input.provenance,
    confidence: input.confidence,
    source: input.source,
    sourceUrl: input.sourceUrl,
    date: input.date,
    verified: input.verified ?? false,
    notes: input.notes ?? [],
  };
}

export function psdFromTable(
  points: PSDPoint[],
  meta: Omit<PercentileInput, "d50Um" | "d10Um" | "d90Um">,
): PSD {
  const sorted = [...points].sort((x, y) => x.sizeUm - y.sizeUm);
  return {
    kind: "table",
    label: meta.label,
    points: sorted,
    provenance: meta.provenance,
    confidence: meta.confidence,
    source: meta.source,
    sourceUrl: meta.sourceUrl,
    date: meta.date,
    verified: meta.verified ?? false,
    notes: meta.notes ?? [],
  };
}

/**
 * Geometric standard deviation implied by a percentile PSD.
 * Uses D10 and D90 when both are present (the widest available lever), then
 * falls back to whichever single percentile pair exists, then to the documented
 * default.
 */
export function geometricStdDevOf(psd: PSD): { value: number; assumed: boolean } {
  if (psd.kind === "table") {
    const d10 = quantileFromTable(psd, 10);
    const d90 = quantileFromTable(psd, 90);
    if (d10 && d90 && d90 > d10) {
      return { value: Math.exp(Math.log(d90 / d10) / (2 * Z90)), assumed: false };
    }
    return { value: DEFAULT_GEOMETRIC_STD_DEV, assumed: true };
  }

  const { d10Um, d50Um, d90Um } = psd;
  if (d10Um && d90Um && d90Um > d10Um) {
    return { value: Math.exp(Math.log(d90Um / d10Um) / (2 * Z90)), assumed: false };
  }
  if (d50Um && d90Um && d90Um > d50Um) {
    return { value: Math.exp(Math.log(d90Um / d50Um) / Z90), assumed: false };
  }
  if (d50Um && d10Um && d50Um > d10Um) {
    return { value: Math.exp(Math.log(d50Um / d10Um) / Z90), assumed: false };
  }
  return { value: DEFAULT_GEOMETRIC_STD_DEV, assumed: true };
}

/* -------------------------------------------------------------------------- */
/* Evaluation                                                                  */
/* -------------------------------------------------------------------------- */

/** Cumulative mass % finer than `sizeUm`. Always within [0, 100]. */
export function cumulativePassingPercent(psd: PSD, sizeUm: number): number {
  if (!Number.isFinite(sizeUm) || sizeUm <= 0) return 0;

  if (psd.kind === "table") {
    const pts = psd.points ?? [];
    if (pts.length === 0) return 0;
    if (sizeUm <= pts[0].sizeUm) {
      // Clamp below the tabulated range rather than extrapolating.
      return sizeUm === pts[0].sizeUm ? pts[0].cumulativePassingPercent : 0;
    }
    const last = pts[pts.length - 1];
    if (sizeUm >= last.sizeUm) return last.cumulativePassingPercent;

    for (let i = 1; i < pts.length; i += 1) {
      const lo = pts[i - 1];
      const hi = pts[i];
      if (sizeUm <= hi.sizeUm) {
        const t = (Math.log(sizeUm) - Math.log(lo.sizeUm)) / (Math.log(hi.sizeUm) - Math.log(lo.sizeUm));
        return clamp(
          lo.cumulativePassingPercent + t * (hi.cumulativePassingPercent - lo.cumulativePassingPercent),
          0,
          100,
        );
      }
    }
    return last.cumulativePassingPercent;
  }

  const d50 = psd.d50Um;
  if (!d50 || d50 <= 0) return 0;
  const sigmaG = geometricStdDevOf(psd).value;
  const lnSigma = Math.log(Math.max(sigmaG, 1.0001));
  const z = Math.log(sizeUm / d50) / lnSigma;
  return clamp(normCdf(z) * 100, 0, 100);
}

/** Mass % coarser than `sizeUm` - i.e. the fraction a sharp cut would retain. */
export function fractionAbovePercent(psd: PSD, sizeUm: number): number {
  return clamp(100 - cumulativePassingPercent(psd, sizeUm), 0, 100);
}

export function fractionBelowPercent(psd: PSD, sizeUm: number): number {
  return cumulativePassingPercent(psd, sizeUm);
}

/** Mass fraction (0..1) in the half-open size interval [fromUm, toUm). */
export function massFractionBetween(psd: PSD, fromUm: number, toUm: number | null): number {
  const lower = cumulativePassingPercent(psd, fromUm);
  const upper = toUm === null ? 100 : cumulativePassingPercent(psd, toUm);
  return clamp((upper - lower) / 100, 0, 1);
}

/** Size at which `percent` % of the mass is finer. */
export function quantile(psd: PSD, percent: number): number {
  if (psd.kind === "table") {
    const v = quantileFromTable(psd, percent);
    return v ?? Number.NaN;
  }
  const d50 = psd.d50Um;
  if (!d50 || d50 <= 0) return Number.NaN;
  const sigmaG = geometricStdDevOf(psd).value;
  return d50 * Math.exp(normInv(clamp(percent, 0.001, 99.999) / 100) * Math.log(sigmaG));
}

function quantileFromTable(psd: PSD, percent: number): number | undefined {
  const pts = psd.points ?? [];
  if (pts.length < 2) return undefined;
  if (percent <= pts[0].cumulativePassingPercent) return pts[0].sizeUm;
  const last = pts[pts.length - 1];
  if (percent >= last.cumulativePassingPercent) return last.sizeUm;

  for (let i = 1; i < pts.length; i += 1) {
    const lo = pts[i - 1];
    const hi = pts[i];
    if (percent <= hi.cumulativePassingPercent) {
      const span = hi.cumulativePassingPercent - lo.cumulativePassingPercent;
      if (span <= 0) return hi.sizeUm;
      const t = (percent - lo.cumulativePassingPercent) / span;
      return Math.exp(Math.log(lo.sizeUm) + t * (Math.log(hi.sizeUm) - Math.log(lo.sizeUm)));
    }
  }
  return last.sizeUm;
}

/* -------------------------------------------------------------------------- */
/* Bands and summary statistics                                                */
/* -------------------------------------------------------------------------- */

const BAND_EDGES: { fromUm: number; toUm: number | null; label: string }[] = [
  { fromUm: 0, toUm: 1, label: "< 1 µm (colloidal / very fine)" },
  { fromUm: 1, toUm: 2, label: "1 - 2 µm (clay-sized)" },
  { fromUm: 2, toUm: 5, label: "2 - 5 µm (fine silt)" },
  { fromUm: 5, toUm: 10, label: "5 - 10 µm (medium silt)" },
  { fromUm: 10, toUm: 20, label: "10 - 20 µm (coarse silt)" },
  { fromUm: 20, toUm: 50, label: "20 - 50 µm (very coarse silt)" },
  { fromUm: 50, toUm: 100, label: "50 - 100 µm (very fine sand)" },
  { fromUm: 100, toUm: 250, label: "100 - 250 µm (fine sand)" },
  { fromUm: 250, toUm: null, label: "> 250 µm (medium sand and coarser)" },
];

export function psdBands(psd: PSD): PSDBand[] {
  return BAND_EDGES.map((band) => ({
    ...band,
    massPercent: round(massFractionBetween(psd, band.fromUm === 0 ? 1e-4 : band.fromUm, band.toUm) * 100, 2),
  }));
}

/**
 * Full deterministic summary of a distribution. `calculatePSDStatistics` is the
 * same function under the name used in the specification.
 */
export function analysePSD(psd: PSD): PSDStatistics {
  const { value: sigmaG, assumed: sigmaAssumed } = geometricStdDevOf(psd);
  const notes = [...(psd.notes ?? [])];

  if (psd.kind === "percentiles") {
    notes.push(
      "Distribution reconstructed from percentiles by fitting a log-normal curve. " +
        "This is a modelling choice; a measured full distribution may differ, " +
        "particularly in the tails.",
    );
  }
  if (sigmaAssumed) {
    notes.push(
      `Distribution spread was not determinable from the supplied data, so a geometric ` +
        `standard deviation of ${DEFAULT_GEOMETRIC_STD_DEV} was assumed. Supplying D10 and D90 ` +
        `would remove this assumption.`,
    );
  }

  // The statistics are calculated from the supplied evidence, so the strongest
  // claim they can carry is "calculated" - and never stronger than the input.
  const provenance: Provenance = psd.provenance === "assumed" ? "assumed" : "calculated";

  return {
    d10Um: round(quantile(psd, 10), 3),
    d25Um: round(quantile(psd, 25), 3),
    d50Um: round(quantile(psd, 50), 3),
    d75Um: round(quantile(psd, 75), 3),
    d90Um: round(quantile(psd, 90), 3),
    span: round((quantile(psd, 90) - quantile(psd, 10)) / Math.max(quantile(psd, 50), 1e-9), 3),
    geometricStdDev: round(sigmaG, 3),
    bands: psdBands(psd),
    provenance,
    confidence: psd.confidence,
    label: psd.label,
    verified: psd.verified,
    notes,
  };
}

/** Specification alias for `analysePSD`. */
export const calculatePSDStatistics = analysePSD;

/**
 * Percentage of the distribution above and below each supplied size.
 * Used to answer "what does this membrane actually have to retain?".
 */
export function psdVersusSizes(
  psd: PSD,
  sizesUm: number[],
): { sizeUm: number; abovePercent: number; belowPercent: number }[] {
  return sizesUm.map((sizeUm) => ({
    sizeUm,
    abovePercent: round(fractionAbovePercent(psd, sizeUm), 2),
    belowPercent: round(fractionBelowPercent(psd, sizeUm), 2),
  }));
}

/* -------------------------------------------------------------------------- */
/* Free-text parsing (used by the conversational layer)                        */
/* -------------------------------------------------------------------------- */

/**
 * Extract a PSD from something a user typed, e.g.
 *   "I have a PSD: D10 = 2 µm, D50 = 25 µm and D90 = 150 µm"
 * Returns `undefined` when no D50 can be found - the caller must not invent one.
 */
export function parsePSDFromText(text: string, label = "User-supplied PSD"): PSD | undefined {
  const find = (which: 10 | 50 | 90): number | undefined => {
    const re = new RegExp(`\\bd\\s*[_-]?\\s*${which}\\b[^0-9-]{0,12}(-?\\d+(?:\\.\\d+)?)`, "i");
    const m = text.match(re);
    if (!m) return undefined;
    const v = Number.parseFloat(m[1]);
    return Number.isFinite(v) && v > 0 ? v : undefined;
  };

  const d50Um = find(50);
  if (!d50Um) return undefined;

  return psdFromPercentiles({
    d10Um: find(10),
    d50Um,
    d90Um: find(90),
    label,
    provenance: "measured",
    confidence: "medium",
    source: "Provided by the user in conversation. Not independently verified.",
    verified: false,
    notes: [
      "Supplied conversationally. Confidence is capped at medium because the " +
        "measurement method, sampling point and date are unknown.",
    ],
  });
}

/* -------------------------------------------------------------------------- */

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

export function round(value: number, dp: number): number {
  if (!Number.isFinite(value)) return Number.NaN;
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}
