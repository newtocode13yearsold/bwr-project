/* Forest boundary overlays — "Section déployée" outline with inline border labels */

window.addForestBoundaries = function (map) {

  // Returns CSS rotation angle so text reads along the segment from `prev` to `next`
  function labelAngle(prev, next) {
    const dx = next[1] - prev[1];       // lon diff  → screen x
    const dy = -(next[0] - prev[0]);    // lat diff  → screen y (inverted)
    let angle = Math.atan2(dy, dx) * 180 / Math.PI;
    // Flip if text would be upside-down
    if (angle > 90)  angle -= 180;
    if (angle < -90) angle += 180;
    return angle;
  }

  // ── Section déployée — large operational boundary ────────────────────────────
  // Clockwise from the north point, matches the hand-drawn circle
  const deployedCoords = [
    [49.610, 2.870],  // N  — Forêt de Laigue
    [49.572, 3.042],  // NNE
    [49.505, 3.188],  // NE — Tracy-le-Val area
    [49.412, 3.275],  // E  — west of Attichy
    [49.318, 3.268],  // ESE
    [49.242, 3.162],  // SE — near Villers-Cotterêts
    [49.198, 2.988],  // S  — Crépy-en-Valois area
    [49.218, 2.752],  // SSW
    [49.330, 2.598],  // SW — Verberie / Pont-Sainte-Maxence
    [49.448, 2.528],  // W  — Éstrées-Saint-Denis
    [49.552, 2.605],  // NW
    [49.598, 2.752],  // NNW
  ];

  const n = deployedCoords.length;

  L.polygon(deployedCoords, {
    color: '#16a34a',
    weight: 2.5,
    dashArray: '10 6',
    fillColor: '#16a34a',
    fillOpacity: 0.04,
    opacity: 0.85,
    interactive: false,
  }).addTo(map);

  // Small text labels placed at every other vertex, rotated to follow the border
  for (let i = 0; i < n; i += 2) {
    const prev  = deployedCoords[(i - 1 + n) % n];
    const next  = deployedCoords[(i + 1) % n];
    const angle = labelAngle(prev, next);
    const pos   = deployedCoords[i];

    L.marker(pos, {
      icon: L.divIcon({
        className: '',
        html: `<div style="
          transform: rotate(${angle.toFixed(1)}deg);
          transform-origin: center center;
          font-size: 0.58rem;
          font-weight: 700;
          color: #15803d;
          letter-spacing: 0.09em;
          white-space: nowrap;
          line-height: 1;
          text-shadow: 0 0 4px rgba(255,255,255,0.98), 0 0 8px rgba(255,255,255,0.85);
        ">section déployée</div>`,
        iconSize:   [115, 12],
        iconAnchor: [57, 6],
      }),
      interactive: false,
      zIndexOffset: 500,
    }).addTo(map);
  }
};
