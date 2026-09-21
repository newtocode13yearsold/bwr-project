/* ── BWR GPS distance filter (Kalman-smoothed) ─────────────────────────────────
 *
 * Single source of truth for turning a stream of raw GPS fixes into an honest
 * distance travelled. Both live trackers (js/gps-tracker.js on the map/admin
 * pages and the GpsTracker in js/routes.js) feed every watchPosition() fix
 * through here so they measure distance identically.
 *
 * WHY THIS EXISTS
 * A phone's GPS position is only a guess — off by 5–20 m, worse under the
 * Compiègne canopy. The old approach summed the straight-line distance between
 * every raw fix, so that guessing "wobble" was counted as real walking: a 1 km
 * walk could read 3–5 km, and standing still for 10 min invented ~1–4 km. See
 * the reasoning in tests/gps-filter.test.js.
 *
 * WHAT IT DOES (the same thing Strava/Garmin do, minus map-matching)
 *   1. Rejects fixes whose reported accuracy is worse than `maxAccuracyM`.
 *   2. Runs each fix through a constant-velocity **Kalman filter** whose
 *      measurement variance IS the fix's reported accuracy² — so a confident
 *      fix pulls the estimate hard and a vague one barely nudges it.
 *   3. Only adds distance once the smoothed move clears a dead-band tied to the
 *      filter's own uncertainty (`deadbandK · σ`, floored at `minMoveM`), so
 *      residual jitter never accumulates.
 *   4. Rejects teleport/noise spikes above `maxSpeedKmh`.
 *
 * In simulation this lands a 1 km walk within ~1–3 % (vs 6–100 % over-count
 * before) and cuts standing-still phantom distance from ~1500 m to ~25 m.
 *
 * Usage (after <script src="js/gps-filter.js"></script>):
 *
 *   const gps = createGpsDistanceFilter();          // or pass overrides
 *   const r = gps.push(lat, lng, accuracy, timestampMs);
 *   //   r.accepted → fix passed the accuracy gate (use r.lat/r.lng for the marker)
 *   //   r.added    → km this fix added to the total (0 if filtered out)
 *   //   r.lat/r.lng→ smoothed position (use for the map marker AND saved track)
 *   //   r.std      → current position uncertainty in metres
 *   gps.totalKm;                                     // running total (km)
 *   gps.reset();                                     // start a new session
 * ────────────────────────────────────────────────────────────────────────────── */
(function (global) {
  'use strict';

  const DEFAULTS = {
    maxAccuracyM: 35,   // drop fixes vaguer than this (forest canopy stays forgiving)
    maxSpeedKmh:  60,   // reject teleport spikes (covers fast cycling)
    q:            1.4,  // Kalman process noise, m/s — expected real motion between fixes
    minMoveM:     4,    // hard floor for the dead-band, metres
    deadbandK:    1.0,  // dead-band = deadbandK × current σ (position uncertainty)
    fallbackAccuracyM: 30, // used when a fix reports no/invalid accuracy
  };

  function haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2
            + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
            * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function createGpsDistanceFilter(opts) {
    const cfg = Object.assign({}, DEFAULTS, opts || {});

    // Kalman state (position + a single scalar variance, in metres²).
    let kLat = 0, kLng = 0, variance = -1, kTs = 0;
    // Last point that actually contributed to the distance total.
    let anchor = null; // { lat, lng, t }
    let totalKm = 0;

    function reset() {
      kLat = kLng = 0; variance = -1; kTs = 0;
      anchor = null; totalKm = 0;
    }

    // Feed one raw fix. Returns { accepted, added, lat, lng, std }.
    function push(lat, lng, accuracy, timestampMs) {
      let acc = Number.isFinite(accuracy) && accuracy > 0 ? accuracy : cfg.fallbackAccuracyM;
      // A fix the device itself calls vague is worse than useless — drop it.
      if (Number.isFinite(accuracy) && accuracy > cfg.maxAccuracyM) {
        return { accepted: false, added: 0, lat: kLat, lng: kLng, std: stdM() };
      }
      if (acc < 1) acc = 1; // avoid a zero-variance measurement dominating the filter

      // ── Kalman update ────────────────────────────────────────────────────────
      if (variance < 0) {
        // First fix: seed the estimate.
        kLat = lat; kLng = lng; variance = acc * acc; kTs = timestampMs;
      } else {
        const dt = (timestampMs - kTs) / 1000;
        if (dt > 0) { variance += dt * cfg.q * cfg.q; kTs = timestampMs; } // predict
        const K = variance / (variance + acc * acc);                       // gain
        kLat += K * (lat - kLat);
        kLng += K * (lng - kLng);
        variance = (1 - K) * variance;                                     // correct
      }

      const std = stdM();
      const out = { accepted: true, added: 0, lat: kLat, lng: kLng, std };

      if (!anchor) { anchor = { lat: kLat, lng: kLng, t: timestampMs }; return out; }

      const distKm = haversineKm(anchor.lat, anchor.lng, kLat, kLng);
      const distM  = distKm * 1000;
      const dtH    = (timestampMs - anchor.t) / 3_600_000;
      const kmh    = dtH > 0 ? distKm / dtH : 0;

      // Spike: ignore the move but keep the anchor put, so we don't jump to a bad point.
      if (kmh > cfg.maxSpeedKmh) return out;

      // Dead-band: the move must clearly beat the current position uncertainty.
      // The anchor stays put below the band, so slow real walking still adds up
      // across several fixes instead of being lost each tick.
      const band = Math.max(cfg.minMoveM, cfg.deadbandK * std);
      if (distM < band) return out;

      totalKm += distKm;
      anchor = { lat: kLat, lng: kLng, t: timestampMs };
      out.added = distKm;
      return out;
    }

    function stdM() { return variance < 0 ? Infinity : Math.sqrt(variance); }

    return {
      push,
      reset,
      get totalKm() { return totalKm; },
      get std() { return stdM(); },
    };
  }

  global.createGpsDistanceFilter = createGpsDistanceFilter;
  // Also expose the pure helper for tests / reuse.
  global.gpsHaversineKm = haversineKm;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createGpsDistanceFilter, haversineKm, DEFAULTS };
  }
})(typeof window !== 'undefined' ? window : globalThis);
