/* Forest boundary overlays — draws the "Section déployée" outline around
   Forêt de Compiègne and shows neighbouring forests as context. */

window.addForestBoundaries = function (map) {

  // ── Forêt de Compiègne — deployed section ──────────────────────────────────
  const compiegneCoords = [
    [49.424, 2.779], [49.438, 2.834], [49.445, 2.900],
    [49.441, 2.978], [49.422, 3.058], [49.390, 3.093],
    [49.348, 3.092], [49.298, 3.047], [49.269, 2.958],
    [49.268, 2.860], [49.290, 2.779], [49.358, 2.734],
    [49.396, 2.738],
  ];

  L.polygon(compiegneCoords, {
    color: '#16a34a',
    weight: 2.5,
    dashArray: '10 6',
    fillColor: '#16a34a',
    fillOpacity: 0.04,
    opacity: 0.85,
    interactive: false,
  }).addTo(map);

  L.marker([49.362, 2.912], {
    icon: L.divIcon({
      className: 'forest-deployed-label',
      html: '<span>▶ Section déployée</span>',
      iconSize: null,
      iconAnchor: [0, 0],
    }),
    interactive: false,
    zIndexOffset: 1000,
  }).addTo(map);

  // ── Forêt de Laigue ─────────────────────────────────────────────────────────
  const laigueCoords = [
    [49.572, 2.703], [49.578, 2.878], [49.564, 2.978],
    [49.513, 2.993], [49.464, 2.942], [49.458, 2.820],
    [49.465, 2.703],
  ];

  L.polygon(laigueCoords, {
    color: '#78716c',
    weight: 1.5,
    dashArray: '5 5',
    fillColor: '#6b7280',
    fillOpacity: 0.05,
    opacity: 0.55,
    interactive: false,
  }).addTo(map);

  L.marker([49.518, 2.848], {
    icon: L.divIcon({
      className: 'forest-nearby-label',
      html: '<span>Forêt de Laigue</span>',
      iconSize: null,
      iconAnchor: [55, 8],
    }),
    interactive: false,
  }).addTo(map);

  // ── Forêt de Retz (Villers-Cotterêts) ──────────────────────────────────────
  const retzCoords = [
    [49.274, 2.950], [49.272, 3.075], [49.278, 3.218],
    [49.220, 3.245], [49.148, 3.215], [49.118, 3.080],
    [49.130, 2.960], [49.198, 2.935],
  ];

  L.polygon(retzCoords, {
    color: '#78716c',
    weight: 1.5,
    dashArray: '5 5',
    fillColor: '#6b7280',
    fillOpacity: 0.05,
    opacity: 0.55,
    interactive: false,
  }).addTo(map);

  L.marker([49.196, 3.088], {
    icon: L.divIcon({
      className: 'forest-nearby-label',
      html: '<span>Forêt de Retz</span>',
      iconSize: null,
      iconAnchor: [48, 8],
    }),
    interactive: false,
  }).addTo(map);
};
