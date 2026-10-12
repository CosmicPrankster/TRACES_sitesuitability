import { describe, expect, it } from "vitest";
import { bngToWgs84, wgs84ToBng } from "@/scripts/lib/bng.mjs";

describe("bngToWgs84: the inverse of wgs84ToBng, needed for the EA water-quality geo search", () => {
  it("round-trips Tilford to within a few metres", () => {
    const lat = 51.154565, lon = -0.791587;
    const bng = wgs84ToBng(lat, lon);
    const back = bngToWgs84(bng.easting, bng.northing);
    expect(back.lat).toBeCloseTo(lat, 4);
    expect(back.lon).toBeCloseTo(lon, 4);
  });

  it("places a real EA sampling point's BNG coordinates in the right part of the country", () => {
    // SO-F0002057, "PERRYFIELDS,RIVER ROTHER, PROPERTY D/S SOUTH AMBERSHAM
    // STW" - real geometry from a real observation record (probe-results,
    // rebuild phase 3), POINT(495650 120150) EPSG:27700. The River Rother
    // here is the West Sussex one, near Midhurst - roughly 51 N, 0.6 W.
    const { lat, lon } = bngToWgs84(495650, 120150);
    expect(lat).toBeGreaterThan(50.8);
    expect(lat).toBeLessThan(51.2);
    expect(lon).toBeGreaterThan(-0.8);
    expect(lon).toBeLessThan(-0.4);
  });

  it("round-trips St Andrews and OS HQ Southampton, the two points wgs84ToBng is verified against", () => {
    for (const [lat, lon] of [
      [56.3398, -2.7967], // St Andrews
      [50.9097, -1.4044], // OS HQ Southampton
    ]) {
      const bng = wgs84ToBng(lat, lon);
      const back = bngToWgs84(bng.easting, bng.northing);
      expect(back.lat).toBeCloseTo(lat, 3);
      expect(back.lon).toBeCloseTo(lon, 3);
    }
  });
});
