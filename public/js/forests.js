/* Department boundary overlay — "Section déployée" outline (Oise, 60) with inline border labels */

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

  // ── Section déployée — département de l'Oise (60) ─────────────────────────────
  // Official department boundary (france-geojson), simplified to ~100 points.
  const deployedCoords = [
    [49.7583, 1.7838], [49.7393, 1.8395], [49.7225, 1.8206], [49.7016, 1.8490],
    [49.7199, 1.9713], [49.6831, 2.0653], [49.7041, 2.1821], [49.6876, 2.3168],
    [49.6564, 2.3709], [49.6530, 2.4457], [49.6208, 2.4781], [49.6395, 2.5048],
    [49.6188, 2.5665], [49.5969, 2.5714], [49.6110, 2.6260], [49.5718, 2.6496],
    [49.6247, 2.6876], [49.6121, 2.7867], [49.6607, 2.7973], [49.6594, 2.8459],
    [49.6852, 2.8612], [49.6707, 2.8888], [49.7025, 2.8662], [49.7137, 2.8817],
    [49.6653, 2.9550], [49.6940, 2.9484], [49.7055, 2.9774], [49.6803, 3.0262],
    [49.7138, 3.0524], [49.7125, 3.0835], [49.6905, 3.0838], [49.7060, 3.1184],
    [49.6619, 3.1277], [49.6567, 3.0978], [49.6313, 3.1128], [49.6225, 3.0936],
    [49.5760, 3.1384], [49.5270, 3.1276], [49.5134, 3.0958], [49.4863, 3.1239],
    [49.4682, 3.1071], [49.4470, 3.1662], [49.4372, 3.0978], [49.3765, 3.0951],
    [49.3700, 3.1350], [49.3300, 3.1550], [49.2900, 3.1450], [49.2600, 3.0900],
    [49.2304, 3.0419], [49.2270, 2.9587], [49.1869, 2.9735], [49.1692, 3.0379],
    [49.1990, 2.9973], [49.2166, 3.0188], [49.1904, 3.0850], [49.1549, 3.0926],
    [49.1975, 3.1007], [49.1664, 3.1083], [49.1608, 3.1481], [49.1421, 3.0934],
    [49.0851, 3.0650], [49.0702, 2.8546], [49.0975, 2.8093], [49.0605, 2.7350],
    [49.1084, 2.6333], [49.0806, 2.5830], [49.1246, 2.5533], [49.0996, 2.5311],
    [49.1064, 2.4899], [49.1176, 2.5033], [49.1354, 2.4716], [49.1474, 2.3593],
    [49.1864, 2.3109], [49.1513, 2.2296], [49.1807, 2.2186], [49.1639, 2.1688],
    [49.2105, 2.0809], [49.1625, 1.8826], [49.1798, 1.7427], [49.2073, 1.7148],
    [49.2234, 1.7405], [49.2349, 1.6990], [49.2614, 1.7069], [49.2724, 1.7587],
    [49.2466, 1.7906], [49.2734, 1.8027], [49.2911, 1.7725], [49.3662, 1.7610],
    [49.3940, 1.7205], [49.4057, 1.7404], [49.4092, 1.7139], [49.5035, 1.7902],
    [49.5039, 1.7164], [49.5384, 1.7483], [49.5800, 1.6907], [49.5888, 1.7216],
    [49.6011, 1.6937], [49.6220, 1.7216], [49.6439, 1.6987], [49.6944, 1.7511],
    [49.6948, 1.6896], [49.7637, 1.7503],
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

  // Place ~6 "section déployée" labels spread around the border, rotated to follow it
  const LABELS = 6;
  const stride = Math.max(1, Math.round(n / LABELS));
  for (let i = 0; i < n; i += stride) {
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
