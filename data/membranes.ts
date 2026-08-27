import type { MembraneOption } from "@/types";

/**
 * MEMBRANE / FILTER CATALOGUE
 * ===========================
 *
 * The user never enters a pore size. This list defines the filtration ratings
 * the matrix is screened against. The purpose is NOT to recommend a commercial
 * product; it is to answer:
 *
 *   "At what filtration rating does hydrocyclone pre-treatment appear useful?"
 *
 * For the MVP the only variable that matters is `poreSizeUm`. The remaining
 * fields exist so that verified manufacturer data can be added later without a
 * schema change. Do not populate `manufacturer`/`model` unless you actually
 * have that product's data.
 *
 * To change the screened range, edit this array. To temporarily exclude a
 * rating, set `enabled: false` rather than deleting the entry.
 */
export const membraneOptions: MembraneOption[] = [
  { id: "1um", poreSizeUm: 1, unit: "µm", label: "1 µm", rating: "unspecified", enabled: true },
  { id: "2um", poreSizeUm: 2, unit: "µm", label: "2 µm", rating: "unspecified", enabled: true },
  { id: "5um", poreSizeUm: 5, unit: "µm", label: "5 µm", rating: "unspecified", enabled: true },
  { id: "10um", poreSizeUm: 10, unit: "µm", label: "10 µm", rating: "unspecified", enabled: true },
  { id: "20um", poreSizeUm: 20, unit: "µm", label: "20 µm", rating: "unspecified", enabled: true },
  { id: "50um", poreSizeUm: 50, unit: "µm", label: "50 µm", rating: "unspecified", enabled: true },
  { id: "100um", poreSizeUm: 100, unit: "µm", label: "100 µm", rating: "unspecified", enabled: true },
];

/**
 * Retention behaviour is rating-dependent. An "absolute" rating retains
 * essentially everything coarser than the pore size; a "nominal" rating passes
 * a meaningful fraction of it. Where the rating is unspecified the engine
 * treats retention as an idealised sharp cut at the pore size and says so, so
 * that the membrane-load figures are read as an approximation rather than a
 * specification.
 */
export const MEMBRANE_RETENTION_NOTE =
  "Membrane ratings in this catalogue are unspecified (neither confirmed nominal " +
  "nor absolute). The engine models retention as an idealised sharp cut at the " +
  "stated pore size. A real nominal-rated element will pass some particles " +
  "coarser than its rating, and a real element's retention also changes as a " +
  "cake forms. Treat the membrane-load percentages as indicative only.";
