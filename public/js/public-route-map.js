// Draws the shared route on a Leaflet map for the public /r/:token page.
// Reads coords from the non-executable <script type="application/json" id="bwr-route">
// block the Worker embedded (keeps the page CSP-clean: script-src 'self').
// Tiles come from the same-origin edge-cached topo proxy (worker/handlers/tiles.js).
(function () {
  'use strict';

  var el = document.getElementById('bwr-route');
  var mapEl = document.getElementById('bwr-map');
  if (!el || !mapEl || typeof L === 'undefined') return;

  var data;
  try { data = JSON.parse(el.textContent); } catch (e) { return; }
  var coords = Array.isArray(data.coords) ? data.coords : [];
  if (coords.length < 2) { mapEl.style.display = 'none'; return; }

  var COLORS = { easy: '#22c55e', medium: '#f97316', hard: '#ef4444' };
  var color = COLORS[data.difficulty] || '#22c55e';

  var map = L.map('bwr-map', { zoomControl: true, scrollWheelZoom: false, preferCanvas: true });

  L.tileLayer('/tiles/topo/{z}/{x}/{y}.png', {
    attribution: 'Map data: © OpenStreetMap contributors, SRTM | Style: © OpenTopoMap',
    maxNativeZoom: 15,
    maxZoom: 17,
  }).addTo(map);

  var line = L.polyline(coords, { color: color, weight: 5, opacity: 0.9 }).addTo(map);
  map.fitBounds(line.getBounds(), { padding: [30, 30] });

  // Start (green) and end (checkered/red) markers as lightweight vector circles
  // so no external marker-image is needed (keeps CSP img-src simple).
  L.circleMarker(coords[0], { radius: 7, color: '#fff', weight: 2, fillColor: '#16a34a', fillOpacity: 1 })
    .addTo(map).bindPopup('Départ');
  L.circleMarker(coords[coords.length - 1], { radius: 7, color: '#fff', weight: 2, fillColor: '#dc2626', fillOpacity: 1 })
    .addTo(map).bindPopup('Arrivée');

  // Let the user opt into wheel-zoom by clicking the map first (avoids hijacking page scroll).
  map.on('click', function () { map.scrollWheelZoom.enable(); });
})();
