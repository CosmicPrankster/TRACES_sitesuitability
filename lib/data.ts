import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Loads and validates the four data files.
 *
 * Validation is deliberately strict and runs in tests: a malformed data file
 * should fail loudly here rather than quietly produce a wrong screening.
 */

const DATA_DIR = join(process.cwd(), "data");

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(DATA_DIR, name), "utf8")) as T;
}

/* -------------------------------------------------------------------- */

/** How much a number is to be trusted. Travels with the value, always. */
export type ValueStatus = "guessed" | "field-adjusted" | "measured";

export interface Hydrocyclone {
  id: string;
  name: string;
  diameterMm: number;
  /** Separation sizes: the size at which 20/50/90 % of that size reports to underflow. */
  cut: { d20Um: number; d50Um: number; d90Um: number };
  operating: {
    flowLpmMin: number;
    flowLpmMax: number;
    pressureBarMin: number;
    pressureBarMax: number;
  };
  status: { diameterMm: ValueStatus; cut: ValueStatus; operating: ValueStatus };
  source: string;
  notes: string[];
  revisions: {
    date: string;
    changed: string;
    from: unknown;
    to: unknown;
    because: string;
  }[];
}

export interface Membrane {
  id: string;
  poreSizeUm: number;
  label: string;
  enabled: boolean;
  product: {
    populated: boolean;
    manufacturer: string | null;
    productCode: string | null;
    material: string | null;
    /** Manufacturer's stated retention, which may differ from the pore size. */
    retentionUm: number | null;
    rating: "nominal" | "absolute" | "unstated";
    sourceUrl: string | null;
    retrievedOn: string | null;
    notes: string[];
  };
}

export interface FieldObservation {
  id: string;
  siteId: string;
  waterbodyId: string;
  siteName: string;
  date: string | null;
  observer: string | null;
  kind: "separation-confirmed" | "no-separation" | "blockage" | "solids-character" | "other";
  /** The single most important qualifier on any observation. */
  feed: "natural" | "disturbed-bed" | "spiked";
  hydrocycloneIds: string[];
  membraneIds: string[];
  observation: string;
  shows: string[];
  /** Never optional. This is what stops a result being over-read. */
  doesNotShow: string[];
  confidence: "low" | "medium" | "high";
  evidenceRef: string | null;
}

export type TrialStatus = "awaiting-data" | "recorded";

export interface Trial {
  id: string;
  date: string | null;
  operator: string | null;
  siteId: string | null;
  waterbodyId: string | null;
  hydrocycloneId: string | null;
  feed: {
    material: string | null;
    preparation: string | null;
    concentrationMgL: number | null;
    psdMeasured: boolean;
    note: string;
  };
  filter: {
    poreSizeUm: number | null;
    diameterMm: number | null;
    material: string | null;
  };
  /** How the run was decided to be over. The field most often forgotten. */
  terminalCondition: string | null;
  volumeBeforeMl: number | null;
  volumeAfterMl: number | null;
  replicates: number | null;
  status: TrialStatus;
  notes: string[];
}

export interface QueryLogEntry {
  siteId: string;
  waterbodyId: string;
  siteName: string;
  waterbodyName: string;
  firstScreenedAt: string;
  lastScreenedAt: string;
  runs: number;
  lastResult: unknown;
}

/* -------------------------------------------------------------------- */

export function loadHydrocyclones(): Hydrocyclone[] {
  return readJson<{ hydrocyclones: Hydrocyclone[] }>("hydrocyclones.json").hydrocyclones;
}

export function loadMembranes(): Membrane[] {
  return readJson<{ membranes: Membrane[] }>("membranes.json").membranes
    .filter((m) => m.enabled)
    .sort((a, b) => a.poreSizeUm - b.poreSizeUm);
}

export function loadFieldObservations(): FieldObservation[] {
  return readJson<{ observations: FieldObservation[] }>("field-observations.json").observations;
}

export function loadTrials(): Trial[] {
  return readJson<{ trials: Trial[] }>("trials.json").trials;
}

export function loadQueryLog(): QueryLogEntry[] {
  return readJson<{ entries: QueryLogEntry[] }>("query-log.json").entries;
}

/** The log key. Never the text the user typed. */
export function logKey(siteId: string, waterbodyId: string): string {
  return `${siteId}::${waterbodyId}`;
}

/* -------------------------------------------------------------------- */

export interface ValidationIssue {
  file: string;
  id: string;
  problem: string;
}

export interface DataSet {
  hydrocyclones: Hydrocyclone[];
  membranes: Membrane[];
  observations: FieldObservation[];
  trials: Trial[];
  log: QueryLogEntry[];
}

/** Reads all five files from disk. */
export function loadAll(): DataSet {
  return {
    hydrocyclones: loadHydrocyclones(),
    membranes: loadMembranes(),
    observations: loadFieldObservations(),
    trials: loadTrials(),
    log: loadQueryLog(),
  };
}

/** Validates the data files as they are on disk. */
export function validateData(): ValidationIssue[] {
  return validate(loadAll());
}

/**
 * Every rule the data must obey. Pure, so it can be tested against deliberately
 * broken input - a validator nobody has seen reject anything is not a validator.
 * Returns all issues rather than throwing on the first.
 */
export function validate(data: DataSet): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (file: string, id: string, problem: string) => issues.push({ file, id, problem });

  /* --- hydrocyclones --- */
  const cyclones = data.hydrocyclones;
  const cycloneIds = new Set<string>();
  for (const h of cyclones) {
    if (cycloneIds.has(h.id)) add("hydrocyclones", h.id, "duplicate id");
    cycloneIds.add(h.id);

    if (!(h.diameterMm > 0)) add("hydrocyclones", h.id, "diameterMm must be positive");
    const { d20Um, d50Um, d90Um } = h.cut ?? {};
    if (!(d20Um > 0 && d50Um > 0 && d90Um > 0)) {
      add("hydrocyclones", h.id, "cut sizes must all be positive");
    } else if (!(d20Um < d50Um && d50Um < d90Um)) {
      add("hydrocyclones", h.id, `cut sizes must increase: d20 ${d20Um} < d50 ${d50Um} < d90 ${d90Um}`);
    }
    if (h.operating.flowLpmMin >= h.operating.flowLpmMax) {
      add("hydrocyclones", h.id, "flow range is inverted or zero-width");
    }
    for (const key of ["diameterMm", "cut", "operating"] as const) {
      if (!["guessed", "field-adjusted", "measured"].includes(h.status?.[key])) {
        add("hydrocyclones", h.id, `status.${key} must be guessed | field-adjusted | measured`);
      }
    }
    if (!Array.isArray(h.revisions)) add("hydrocyclones", h.id, "revisions must be an array");
  }

  // Physical ordering: a larger body cannot cut finer than a smaller one.
  const sorted = [...cyclones].sort((a, b) => a.diameterMm - b.diameterMm);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].cut.d50Um < sorted[i - 1].cut.d50Um) {
      add("hydrocyclones", sorted[i].id,
        `d50 ${sorted[i].cut.d50Um} µm is finer than the smaller ${sorted[i - 1].name}, which is backwards`);
    }
  }

  /* --- membranes --- */
  const membranes = data.membranes;
  const membraneIds = new Set<string>();
  for (const m of membranes) {
    if (membraneIds.has(m.id)) add("membranes", m.id, "duplicate id");
    membraneIds.add(m.id);
    if (!(m.poreSizeUm > 0)) add("membranes", m.id, "poreSizeUm must be positive");
    if (m.product.populated && !m.product.sourceUrl) {
      add("membranes", m.id, "product marked populated but has no sourceUrl");
    }
    if (!m.product.populated && m.product.manufacturer) {
      add("membranes", m.id, "has manufacturer data but is not marked populated");
    }
  }

  /* --- field observations --- */
  const observationIds = new Set<string>();
  for (const o of data.observations) {
    if (observationIds.has(o.id)) add("field-observations", o.id, "duplicate id");
    observationIds.add(o.id);
    if (!o.siteId || !o.waterbodyId) {
      add("field-observations", o.id, "must have both siteId and waterbodyId");
    }
    if (!o.observation?.trim()) add("field-observations", o.id, "observation text is empty");
    if (!Array.isArray(o.doesNotShow) || o.doesNotShow.length === 0) {
      add("field-observations", o.id, "doesNotShow must not be empty - state the limits of what you saw");
    }
    if (!["natural", "disturbed-bed", "spiked"].includes(o.feed)) {
      add("field-observations", o.id, "feed must be natural | disturbed-bed | spiked");
    }
    for (const id of o.hydrocycloneIds ?? []) {
      if (!cycloneIds.has(id)) add("field-observations", o.id, `references unknown hydrocyclone "${id}"`);
    }
    for (const id of o.membraneIds ?? []) {
      if (!membraneIds.has(id)) add("field-observations", o.id, `references unknown membrane "${id}"`);
    }
  }

  /* --- trials --- */
  const trialIds = new Set<string>();
  for (const t of data.trials) {
    if (trialIds.has(t.id)) add("trials", t.id, "duplicate id");
    trialIds.add(t.id);

    if (!["awaiting-data", "recorded"].includes(t.status)) {
      add("trials", t.id, "status must be awaiting-data | recorded");
    }
    if (t.hydrocycloneId && !cycloneIds.has(t.hydrocycloneId)) {
      add("trials", t.id, `references unknown hydrocyclone "${t.hydrocycloneId}"`);
    }

    // A trial marked recorded is claiming to be usable evidence - enforce
    // that everything needed to actually use it is present, especially the
    // field most often forgotten: how the run was decided to be over.
    if (t.status === "recorded") {
      if (!t.hydrocycloneId) add("trials", t.id, "recorded trial must reference a hydrocycloneId");
      if (!(t.volumeBeforeMl! > 0) || !(t.volumeAfterMl! > 0)) {
        add("trials", t.id, "recorded trial must have positive volumeBeforeMl and volumeAfterMl");
      }
      if (!(t.filter?.poreSizeUm! > 0) || !(t.filter?.diameterMm! > 0)) {
        add("trials", t.id, "recorded trial must have a positive filter poreSizeUm and diameterMm");
      }
      if (!t.terminalCondition?.trim()) {
        add("trials", t.id, "recorded trial must state terminalCondition - how the run was stopped");
      }
      if (!t.feed?.material?.trim()) {
        add("trials", t.id, "recorded trial must state feed.material");
      }
    }
  }

  /* --- query log --- */
  const seen = new Set<string>();
  for (const e of data.log) {
    const key = logKey(e.siteId, e.waterbodyId);
    if (seen.has(key)) add("query-log", key, "duplicate site + waterbody entry");
    seen.add(key);
    if (!e.siteId || !e.waterbodyId) add("query-log", key, "must have both siteId and waterbodyId");
  }

  return issues;
}
