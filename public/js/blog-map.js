// Draws a small interactive map of points-of-interest (parkings, viewpoints,
// water, etc.) inside a blog article. Reads the pins from a non-executable
// <script type="application/json" id="bwr-spots"> block so the page stays
// CSP-clean (script-src 'self', no inline JS). Tiles come from the same-origin
// edge-cached topo proxy (worker/handlers/tiles.js), same as the map pages.
(function () {
  'use strict';

  var el = document.getElementById('bwr-spots');
  var mapEl = document.getElementById('bwr-map');
  if (!el || !mapEl || typeof L === 'undefined') return;

  var data;
  try { data = JSON.parse(el.textContent); } catch (e) { mapEl.style.display = 'none'; return; }
  var spots = Array.isArray(data.spots) ? data.spots : [];
  if (!spots.length) { mapEl.style.display = 'none'; return; }

  var map = L.map('bwr-map', { zoomControl: true, scrollWheelZoom: false, preferCanvas: true });

  L.tileLayer('/tiles/topo/{z}/{x}/{y}.png', {
    attribution: 'Map data: © OpenStreetMap contributors, SRTM | Style: © OpenTopoMap',
    maxNativeZoom: 15,
    maxZoom: 17,
  }).addTo(map);

  var latlngs = [];

  spots.forEach(function (s) {
    if (typeof s.lat !== 'number' || typeof s.lng !== 'number') return;
    latlngs.push([s.lat, s.lng]);

    // Emoji pin as a divIcon — no external marker image needed (keeps CSP img-src simple).
    var emoji = s.emoji || '📍';
    var icon = L.divIcon({
      className: 'bwr-blog-pin',
      html: '<div style="font-size:26px;line-height:26px;text-align:center;'
          + 'filter:drop-shadow(0 1px 2px rgba(0,0,0,.45));cursor:pointer">' + emoji + '</div>',
      iconSize: [30, 30],
      iconAnchor: [15, 28],
      popupAnchor: [0, -26],
    });

    var marker = L.marker([s.lat, s.lng], { icon: icon }).addTo(map);

    var title = s.title ? String(s.title) : '';
    var note = s.note ? String(s.note) : '';
    var link = s.link ? String(s.link) : '';
    var html = '';
    if (title) html += '<strong>' + escapeHtml(title) + '</strong>';
    if (note) html += (html ? '<br>' : '') + '<span>' + escapeHtml(note) + '</span>';
    if (link) {
      html += (html ? '<br>' : '')
        + '<a href="' + escapeAttr(link) + '" style="color:#166534;font-weight:600;text-decoration:none">'
        + 'Planifier cette balade →</a>';
    }
    if (html) marker.bindPopup(html);
  });

  if (latlngs.length === 1) {
    map.setView(latlngs[0], typeof data.zoom === 'number' ? data.zoom : 14);
  } else {
    map.fitBounds(L.latLngBounds(latlngs), { padding: [40, 40], maxZoom: 14 });
  }

  // Let the user opt into wheel-zoom by clicking the map first (don't hijack page scroll).
  map.on('click', function () { map.scrollWheelZoom.enable(); });

  function escapeHtml(str) {
    return str.replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function escapeAttr(str) {
    return String(str).replace(/"/g, '%22').replace(/</g, '%3C').replace(/>/g, '%3E');
  }
})();
