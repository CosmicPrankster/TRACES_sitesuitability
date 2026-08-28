export function wgs84ToBng(lat, lon) {
  const deg = Math.PI / 180;
  // 1. WGS84 lat/lon -> cartesian (GRS80/WGS84 ellipsoid)
  const a1 = 6378137.0, b1 = 6356752.3142;
  const e2_1 = (a1 * a1 - b1 * b1) / (a1 * a1);
  const phi = lat * deg, lam = lon * deg;
  const nu1 = a1 / Math.sqrt(1 - e2_1 * Math.sin(phi) ** 2);
  const x1 = nu1 * Math.cos(phi) * Math.cos(lam);
  const y1 = nu1 * Math.cos(phi) * Math.sin(lam);
  const z1 = ((1 - e2_1) * nu1) * Math.sin(phi);

  // 2. Helmert WGS84 -> OSGB36
  const tx = -446.448, ty = 125.157, tz = -542.060;
  const s = 20.4894e-6;
  const rx = (-0.1502 / 3600) * deg, ry = (-0.2470 / 3600) * deg, rz = (-0.8421 / 3600) * deg;
  const x2 = tx + x1 * (1 + s) + y1 * -rz + z1 * ry;
  const y2 = ty + x1 * rz + y1 * (1 + s) + z1 * -rx;
  const z2 = tz + x1 * -ry + y1 * rx + z1 * (1 + s);

  // 3. cartesian -> Airy 1830 lat/lon
  const a = 6377563.396, b = 6356256.909;
  const e2 = (a * a - b * b) / (a * a);
  const p = Math.sqrt(x2 * x2 + y2 * y2);
  let phi2 = Math.atan2(z2, p * (1 - e2)), nu;
  for (let i = 0; i < 10; i++) {
    nu = a / Math.sqrt(1 - e2 * Math.sin(phi2) ** 2);
    phi2 = Math.atan2(z2 + e2 * nu * Math.sin(phi2), p);
  }
  const lam2 = Math.atan2(y2, x2);

  // 4. Airy lat/lon -> National Grid (transverse Mercator)
  const F0 = 0.9996012717, phi0 = 49 * deg, lam0 = -2 * deg, E0 = 400000, N0 = -100000;
  const n = (a - b) / (a + b);
  nu = a * F0 / Math.sqrt(1 - e2 * Math.sin(phi2) ** 2);
  const rho = a * F0 * (1 - e2) / Math.pow(1 - e2 * Math.sin(phi2) ** 2, 1.5);
  const eta2 = nu / rho - 1;
  const dphi = phi2 - phi0, sphi = phi2 + phi0;
  const M = b * F0 * (
    (1 + n + 1.25 * n * n + 1.25 * n ** 3) * dphi
    - (3 * n + 3 * n * n + 2.625 * n ** 3) * Math.sin(dphi) * Math.cos(sphi)
    + (1.875 * n * n + 1.875 * n ** 3) * Math.sin(2 * dphi) * Math.cos(2 * sphi)
    - (35 / 24) * n ** 3 * Math.sin(3 * dphi) * Math.cos(3 * sphi)
  );
  const cp = Math.cos(phi2), sp = Math.sin(phi2), tp = Math.tan(phi2);
  const I = M + N0;
  const II = (nu / 2) * sp * cp;
  const III = (nu / 24) * sp * cp ** 3 * (5 - tp ** 2 + 9 * eta2);
  const IIIA = (nu / 720) * sp * cp ** 5 * (61 - 58 * tp ** 2 + tp ** 4);
  const IV = nu * cp;
  const V = (nu / 6) * cp ** 3 * (nu / rho - tp ** 2);
  const VI = (nu / 120) * cp ** 5 * (5 - 18 * tp ** 2 + tp ** 4 + 14 * eta2 - 58 * tp ** 2 * eta2);
  const dl = lam2 - lam0;
  return {
    easting: Math.round(E0 + IV * dl + V * dl ** 3 + VI * dl ** 5),
    northing: Math.round(I + II * dl ** 2 + III * dl ** 4 + IIIA * dl ** 6),
  };
}

/**
 * WGS84 lat/lon to British National Grid easting/northing.
 *
 * Helmert transform WGS84 -> OSGB36, then transverse Mercator onto the National
 * Grid. Accurate to a few metres, which is far inside the resolution of any
 * geology or catchment dataset this project uses. (OSTN15 would be exact but
 * needs a 20 MB shift file and buys nothing here.)
 *
 * Verified against St Andrews (NO 51 16) and OS HQ Southampton.
 */
