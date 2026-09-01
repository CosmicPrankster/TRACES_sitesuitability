import type { Membrane } from "./data";
import { fractionCoarserThan, type Psd } from "./psd";

/**
 * BLOCK 5c - what a membrane retains.
 *
 * The user's redirection that shapes this: a real filtration trial will
 * almost never exist for a given site. The tool has to work, by default,
 * from published literature and physics, not from waiting on measurement.
 *
 * The physics: a sharp cut at the membrane's retention size - everything
 * coarser than it is retained, everything finer passes. That is the
 * standard simplifying assumption for a screening tool (a real element's
 * retention curve is not perfectly sharp), and it is reported as one.
 *
 * The literature: `data/membranes.json`'s nominal `poreSizeUm` is a
 * starting point, but a manufacturer's product page often states a
 * different, more specific `retentionUm` - use that in preference when it
 * is on file. That is why `product.retentionUm` and `product.rating`
 * exist: hand an agent a supplier URL and ask it to fill them in.
 *
 * `rating` changes what the sharp-cut assumption is worth, not the number
 * itself: "nominal" means a real element still passes a meaningful
 * fraction of particles coarser than its rating, so the sharp cut
 * overstates retention; "absolute" means it does not. Correcting for that
 * would need a real passage curve, which nobody has - so it is surfaced as
 * a caveat, not baked into the number.
 */

export interface MembraneRetention {
  membraneId: string;
  /** The size actually used as the cut point. */
  effectiveRetentionUm: number;
  /** Where effectiveRetentionUm came from. */
  source: "measured-product" | "nominal-pore-size";
  rating: "nominal" | "absolute" | "unstated";
  /** What the rating means for how much to trust a sharp cut at this size. */
  caveat: string;
}

/**
 * Prefers the manufacturer's stated retention size over the nominal pore
 * size when data/membranes.json has it on file.
 */
export function membraneRetention(membrane: Membrane): MembraneRetention {
  const hasProductRetention = membrane.product.populated && membrane.product.retentionUm != null;
  const effectiveRetentionUm = hasProductRetention ? membrane.product.retentionUm! : membrane.poreSizeUm;
  const rating = hasProductRetention ? membrane.product.rating : "unstated";

  const caveat =
    rating === "absolute"
      ? "Absolute rating: a real element holds close to a hard cut at this size, so the sharp-cut assumption is reasonable."
      : rating === "nominal"
        ? "Nominal rating: a real element still passes a meaningful fraction of particles coarser than this size, so a sharp cut overstates what is actually retained."
        : "No manufacturer rating basis on file: the sharp cut at the nominal pore size is a rough approximation, unverified against any product page.";

  return {
    membraneId: membrane.id,
    effectiveRetentionUm,
    source: hasProductRetention ? "measured-product" : "nominal-pore-size",
    rating,
    caveat,
  };
}

/**
 * Mass fraction (0..1) of the given distribution the membrane retains,
 * under the sharp-cut assumption at its effective retention size.
 */
export function retainedMassFraction(psd: Psd, membrane: Membrane): number {
  return fractionCoarserThan(psd, membraneRetention(membrane).effectiveRetentionUm);
}
