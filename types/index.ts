/**
 * Shared domain types for the hydrocyclone + membrane site screening agent.
 *
 * The central design idea is that no bare number is ever passed around. Every
 * externally-sourced or derived quantity is wrapped in an `Evidence<T>` record
 * carrying its provenance and confidence, so the report can always answer
 * "how do you know that?" and so the engine can propagate the weakest link in
 * the evidence chain into the final confidence.
 */

/**
 * How a value came to exist. Ordered from strongest to weakest; the screening
 * engine uses this order to downgrade confidence.
 */
export type Provenance =
  | "measured" // taken at this site with an instrument
  | "published" // stated in a citable public source
  | "calculated" // derived deterministically from other evidence
  | "inferred" // reasoned from context, not directly stated anywhere
  | "assumed"; // a screening placeholder chosen to let the analysis proceed

export const PROVENANCE_STRENGTH: Record<Provenance, number> = {
  measured: 5,
  published: 4,
  calculated: 3,
  inferred: 2,
  assumed: 1,
};

export type Confidence = "high" | "medium" | "low" | "unknown";

export const CONFIDENCE_STRENGTH: Record<Confidence, number> = {
  high: 3,
  medium: 2,
  low: 1,
  unknown: 0,
};

/** A single value together with everything needed to audit it. */
export interface Evidence<T = number> {
  value: T;
  unit?: string;
  provenance: Provenance;
  confidence: Confidence;
  /** Human-readable description of where this came from. */
  source?: string;
  sourceUrl?: string;
  /** ISO date of the source or measurement. */
  date?: string;
  /**
   * True only when a human has checked the value against the cited source.
   * Placeholder/screening values must be `false`.
   */
  verified: boolean;
  notes?: string;
}

export interface Reference {
  title: string;
  authors?: string;
  year?: number;
  publication?: string;
  doi?: string;
  url?: string;
  notes?: string;
}

/* -------------------------------------------------------------------------- */
/* Hydrocyclone catalogue                                                      */
/* -------------------------------------------------------------------------- */

export interface HydrocycloneGeometry {
  inletDiameterMm?: Evidence<number>;
  inletType?: Evidence<string>;
  vortexFinderDiameterMm?: Evidence<number>;
  vortexFinderLengthMm?: Evidence<number>;
  apexDiameterMm?: Evidence<number>;
  coneAngleDeg?: Evidence<number>;
  cylindricalLengthMm?: Evidence<number>;
  totalLengthMm?: Evidence<number>;
  /** e.g. "Rietema", "Bradley", "Mozley", "manufacturer proprietary". */
  geometryFamily?: Evidence<string>;
}

export interface OperatingEnvelope {
  flowMinLpm?: Evidence<number>;
  flowMaxLpm?: Evidence<number>;
  pressureMinBar?: Evidence<number>;
  pressureMaxBar?: Evidence<number>;
  /** Pressure drop across the unit at the reference flow. */
  pressureDropBar?: Evidence<number>;
  maxFeedSolidsPercent?: Evidence<number>;
}

/** Conditions under which a cut size or efficiency figure was obtained. */
export interface ReferenceConditions {
  particleDensityKgM3?: Evidence<number>;
  liquidDensityKgM3?: Evidence<number>;
  liquidViscosityPaS?: Evidence<number>;
  feedSolidsPercent?: Evidence<number>;
  feedFlowLpm?: Evidence<number>;
  feedPressureBar?: Evidence<number>;
  temperatureC?: Evidence<number>;
  description?: string;
}

/** One point on a measured or published grade-efficiency curve. */
export interface GradeEfficiencyPoint {
  sizeUm: number;
  /** Mass fraction of that size reporting to the underflow, 0..1. */
  efficiency: number;
}

export interface CutSizeData {
  /** Size at which 50 % of that size reports to the underflow. */
  d50Um?: Evidence<number>;
  d25Um?: Evidence<number>;
  d75Um?: Evidence<number>;
  d90Um?: Evidence<number>;
  /**
   * Sharpness exponent `m` of the reduced grade-efficiency curve
   * G'(d) = (d/d50)^m / (1 + (d/d50)^m).
   * Larger `m` means a sharper cut.
   */
  sharpness?: Evidence<number>;
  /** Published or measured curve. When present it overrides the fitted curve. */
  gradeEfficiencyCurve?: Evidence<GradeEfficiencyPoint[]>;
  /** Fraction of feed liquid short-circuiting to the underflow, 0..1 (Rf). */
  waterSplitRf?: Evidence<number>;
  conditions?: ReferenceConditions;
}

export interface PilotResult {
  siteId: string;
  hydrocycloneId: string;
  membranePoreSizeUm: number;
  feedVolumeLitres?: number;
  membraneVolumeLitres?: number;
  feedSolidsMgL?: number;
  overflowSolidsMgL?: number;
  underflowSolidsMgL?: number;
  pressureBar?: number;
  flowRateLpm?: number;
  date?: string;
  observations?: string[];
  source?: string;
}

export interface Hydrocyclone {
  id: string;
  name: string;
  /** Nominal body diameter. The only field the engine requires. */
  diameterMm: Evidence<number>;
  manufacturer?: string;
  model?: string;
  geometry?: HydrocycloneGeometry;
  operating?: OperatingEnvelope;
  cutSize?: CutSizeData;
  /** Overall (total) separation efficiency where a single figure is published. */
  totalEfficiency?: Evidence<number>;
  references?: Reference[];
  notes?: string[];
  /**
   * Confidence in the catalogue entry as a whole. Entries whose separation
   * data are placeholders must declare "low".
   */
  catalogueConfidence: Confidence;
  /** True when every performance field carries a verified source. */
  dataComplete: boolean;
  pilotResults?: PilotResult[];
}

/* -------------------------------------------------------------------------- */
/* Membrane catalogue                                                          */
/* -------------------------------------------------------------------------- */

export type MembraneRating = "nominal" | "absolute" | "unspecified";

export interface MembraneOption {
  id: string;
  /** Nominal pore size in micrometres - the primary MVP variable. */
  poreSizeUm: number;
  unit: "µm";
  label: string;
  rating?: MembraneRating;
  membraneType?: string;
  material?: string;
  manufacturer?: string;
  model?: string;
  source?: string;
  sourceUrl?: string;
  notes?: string[];
  /** Set false to exclude from the matrix without deleting the entry. */
  enabled: boolean;
}

/* -------------------------------------------------------------------------- */
/* Particle size distribution                                                  */
/* -------------------------------------------------------------------------- */

/** Cumulative percentage (by mass) passing a given size. */
export interface PSDPoint {
  sizeUm: number;
  /** 0..100, cumulative mass % finer than `sizeUm`. */
  cumulativePassingPercent: number;
}

export type PSDKind = "table" | "percentiles";

export interface PSD {
  kind: PSDKind;
  label: string;
  /** Full table, when supplied. */
  points?: PSDPoint[];
  /** Percentile shorthand, when a full table is not available. */
  d10Um?: number;
  d50Um?: number;
  d90Um?: number;
  provenance: Provenance;
  confidence: Confidence;
  source?: string;
  sourceUrl?: string;
  date?: string;
  verified: boolean;
  notes?: string[];
}

export interface PSDBand {
  fromUm: number;
  /** `null` means unbounded above. */
  toUm: number | null;
  label: string;
  massPercent: number;
}

export interface PSDStatistics {
  d10Um: number;
  d25Um: number;
  d50Um: number;
  d75Um: number;
  d90Um: number;
  /** (d90 - d10) / d50 */
  span: number;
  /** Geometric standard deviation implied by the distribution. */
  geometricStdDev: number;
  bands: PSDBand[];
  provenance: Provenance;
  confidence: Confidence;
  label: string;
  verified: boolean;
  notes: string[];
}

/* -------------------------------------------------------------------------- */
/* Site data                                                                   */
/* -------------------------------------------------------------------------- */

export type WaterBodyType =
  | "river"
  | "lake_reservoir"
  | "groundwater"
  | "estuary_coastal"
  | "process_water"
  | "unknown";

/**
 * Broad particle character. Deliberately coarse - the screening engine treats
 * this as a scenario assumption, not a measurement.
 */
export type ParticleCharacter =
  | "sand"
  | "mixed_mineral"
  | "silt"
  | "clay"
  | "organic"
  | "unknown";

/** One auditable fact about the site. */
export interface SiteDatum {
  parameter: string;
  value: string | number;
  unit?: string;
  provenance: Provenance;
  confidence: Confidence;
  source?: string;
  sourceUrl?: string;
  date?: string;
  notes?: string;
}

export interface Assumption {
  id: string;
  statement: string;
  /** Why this assumption was chosen. */
  basis: string;
  confidence: Confidence;
  /** What parts of the assessment this assumption influences. */
  affects: string[];
}

export interface ProviderReport {
  providerId: string;
  providerName: string;
  status: "ok" | "no_data" | "error" | "skipped";
  message: string;
  sourceUrl?: string;
  /** Milliseconds the lookup took. */
  durationMs?: number;
}

export interface SiteData {
  /** The raw string the user typed. */
  query: string;
  resolvedName?: string;
  latitude?: number;
  longitude?: number;
  country?: string;
  waterBody?: string;
  waterBodyType: WaterBodyType;
  catchment?: string;
  geologyNotes: string[];
  landUseNotes: string[];
  particleCharacter: ParticleCharacter;
  particleCharacterProvenance: Provenance;
  /** What led to that character - the audit trail for the biggest single lever. */
  particleCharacterBasis: string;
  /**
   * False when nothing specific to this site influenced the assessment, i.e. the
   * result is the default and would be identical for any other location. The
   * report says so prominently rather than presenting a default as an analysis.
   */
  siteSpecific: boolean;
  /** Every auditable datum gathered, from every provider. */
  data: SiteDatum[];
  psd?: PSD;
  providerReports: ProviderReport[];
  unknowns: string[];
  assumptions: Assumption[];
}

export interface SiteDataProvider {
  id: string;
  name: string;
  getSiteData(location: string, context: SiteLookupContext): Promise<SiteDataFragment>;
}

export interface SiteLookupContext {
  latitude?: number;
  longitude?: number;
  resolvedName?: string;
  /** Seconds budget for the lookup. */
  timeoutMs: number;
  userAgent: string;
  fetchImpl?: typeof fetch;
}

/** Providers return a partial picture; the aggregator merges them. */
export interface SiteDataFragment {
  report: ProviderReport;
  resolvedName?: string;
  latitude?: number;
  longitude?: number;
  country?: string;
  waterBody?: string;
  waterBodyType?: WaterBodyType;
  catchment?: string;
  geologyNotes?: string[];
  landUseNotes?: string[];
  particleCharacter?: ParticleCharacter;
  particleCharacterProvenance?: Provenance;
  particleCharacterBasis?: string;
  data?: SiteDatum[];
  psd?: PSD;
  unknowns?: string[];
  assumptions?: Assumption[];
}

/* -------------------------------------------------------------------------- */
/* Scenario - the mutable object the conversation edits                        */
/* -------------------------------------------------------------------------- */

export interface Scenario {
  siteQuery: string;
  userNotes?: string;
  siteData: SiteData;
  /** User- or AI-supplied overrides layered on top of the site data. */
  particleCharacterOverride?: ParticleCharacter;
  psdOverride?: PSD;
  particleDensityKgM3Override?: number;
  targetFilteredVolumeLitres?: number;
  /** Restrict the matrix. Empty/absent means "all catalogue entries". */
  hydrocycloneIds?: string[];
  membraneIds?: string[];
  /** Free-text scenario changes recorded for the audit trail. */
  changeLog: string[];
}

/* -------------------------------------------------------------------------- */
/* Assessment output                                                           */
/* -------------------------------------------------------------------------- */

export type ScreeningClass =
  | "promising"
  | "potentially_suitable"
  | "marginal"
  | "unlikely"
  | "insufficient_data";

export interface HydraulicCheck {
  status: "compatible" | "unknown" | "out_of_range";
  note: string;
}

export interface ConfigurationMetrics {
  /** Fraction (0..1) of feed solids mass the membrane must retain. */
  membraneLoadFraction?: number;
  /** Fraction (0..1) of that retained load the cyclone could remove upstream. */
  cycloneRemovalOfLoad?: number;
  /**
   * Share (0..1) of the membrane's *resistance-weighted* retained load that the
   * hydrocyclone could remove upstream. This, not the mass fraction, is the
   * primary classification driver: the specific resistance of a filter cake
   * scales roughly with the inverse square of particle size (Carman-Kozeny), so
   * a given mass of fine material loads a membrane far more heavily than the
   * same mass of coarse material.
   */
  foulingReliefFraction?: number;
  /** Fraction (0..1) of total feed solids still reaching the membrane. */
  residualLoadFraction?: number;
  /** Fraction (0..1) of total feed solids removed by the cyclone. */
  overallSolidsRemoval?: number;
  /** Cut size used in this assessment. */
  cutSizeUm?: number;
  cutSizeProvenance?: Provenance;
  fractionAbovePorePercent?: number;
  fractionBelowPorePercent?: number;
}

export interface ConfigurationAssessment {
  hydrocycloneId: string;
  hydrocycloneName: string;
  membraneId: string;
  membraneLabel: string;
  membranePoreSizeUm: number;
  classification: ScreeningClass;
  /** Plain-language label shown to the user. */
  userLabel: string;
  /** Non-colour indicator, so the matrix does not rely on colour alone. */
  symbol: string;
  confidence: Confidence;
  metrics: ConfigurationMetrics;
  /** Ordered engineering reasoning, most important first. */
  reasoning: string[];
  mainUncertainty: string;
  evidence: SiteDatum[];
  assumptions: string[];
  hydraulic: HydraulicCheck;
  limitations: string[];
}

export interface UsefulWindow {
  lowerUm?: number;
  upperUm?: number;
  statement: string;
  confidence: Confidence;
}

export interface DecisionTreeStep {
  question: string;
  answer: string;
  provenance: Provenance;
  consequence: string;
}

export interface ReportNarrative {
  /** Statements that are directly known/observed. */
  known: string[];
  /** Statements backed by a citable public source. */
  published: string[];
  /** Deterministic calculation results. */
  calculated: string[];
  /** Reasoned engineering inference. */
  inferred: string[];
  /** Screening assumptions made to allow the analysis to proceed. */
  assumed: string[];
  /** What follows, given the above. */
  conclusions: string[];
}

export interface ScreeningReport {
  queryId: string;
  timestamp: string;
  siteQuery: string;
  userNotes?: string;
  siteData: SiteData;
  hydrocyclones: Hydrocyclone[];
  membranes: MembraneOption[];
  psdStatistics?: PSDStatistics;
  psdSource?: PSD;
  matrix: ConfigurationAssessment[];
  overall: {
    classification: ScreeningClass;
    userLabel: string;
    confidence: Confidence;
    summary: string;
  };
  usefulWindow: UsefulWindow;
  best: ConfigurationAssessment[];
  borderline: ConfigurationAssessment[];
  unlikely: ConfigurationAssessment[];
  missingData: ConfigurationAssessment[];
  narrative: ReportNarrative;
  unknowns: string[];
  sources: SiteDatum[];
  recommendedNextTests: string[];
  decisionTree: DecisionTreeStep[];
  /** Non-fatal problems: failed providers, unverified catalogue data, etc. */
  warnings: string[];
  scenario: Scenario;
}
