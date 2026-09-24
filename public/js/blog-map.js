// Draws a small interactive map of points-of-interest (parkings, viewpoints,
// water, etc.) — and optionally real trail segments — inside a blog article.
// Reads its content from a non-executable <script type="application/json"
// id="bwr-spots"> block so the page stays CSP-clean (script-src 'self', no
// inline JS). Tiles come from the same-origin edge-cached topo proxy
// (worker/handlers/tiles.js), same as the map pages.
//
// JSON shape: { spots: [{lat,lng,emoji,title,label?,note?,link?}, …],
//               paths?: [{coords:[[lat,lng],…], kind:'good'|'avoid', label?, note?}, …],
//               zoom? }
// Every marker gets a permanent on-map label (`label` if set, else `title`)
// so the reader sees *where* each pin is without having to click it.
(function () {
  'use strict';

  var el = document.getElementById('bwr-spots');
  var mapEl = document.getElementById('bwr-map');
  if (!el || !mapEl || typeof L === 'undefined') return;

  var data;
  try { data = JSON.parse(el.textContent); } catch (e) { mapEl.style.display = 'none'; return; }
  var spots = Array.isArray(data.spots) ? data.spots : [];
  var paths = Array.isArray(data.paths) ? data.paths : [];
  if (!spots.length && !paths.length) { mapEl.style.display = 'none'; return; }

  var map = L.map('bwr-map', { zoomControl: true, scrollWheelZoom: false, preferCanvas: true });

  L.tileLayer('/tiles/topo/{z}/{x}/{y}.png', {
    attribution: 'Map data: © OpenStreetMap contributors, SRTM | Style: © OpenTopoMap',
    maxNativeZoom: 15,
    maxZoom: 17,
  }).addTo(map);

  var latlngs = [];

  // Real trail segments first, so pins draw on top of the lines.
  paths.forEach(function (p) {
    var coords = Array.isArray(p.coords) ? p.coords.filter(function (c) {
      return Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number';
    }) : [];
    if (coords.length < 2) return;
    coords.forEach(function (c) { latlngs.push(c); });

    var isAvoid = p.kind === 'avoid';
    var line = L.polyline(coords, {
      color: isAvoid ? '#dc2626' : '#2d6b1f',
      weight: isAvoid ? 4 : 5,
      opacity: 0.85,
      dashArray: isAvoid ? '7 7' : null,
      lineCap: 'round',
    }).addTo(map);

    var note = p.note ? String(p.note) : '';
    if (note) line.bindPopup('<span>' + escapeHtml(note) + '</span>');

    var label = p.label ? String(p.label) : '';
    if (label) {
      var mid = coords[Math.floor(coords.length / 2)];
      L.marker(mid, {
        icon: L.divIcon({
          className: 'bwr-path-label-wrap',
          html: '',
          iconSize: [0, 0],
        }),
        interactive: false,
        keyboard: false,
      }).addTo(map).bindTooltip(label, {
        permanent: true,
        direction: 'center',
        className: 'bwr-path-label ' + (isAvoid ? 'bwr-path-label-avoid' : 'bwr-path-label-good'),
      }).openTooltip();
    }
  });

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

    // Always-visible place name — so the reader knows *where* a pin is
    // without needing to click it (first thing they see on the article).
    var label = s.label ? String(s.label) : title;
    if (label) {
      marker.bindTooltip(label, {
        permanent: true,
        direction: 'top',
        offset: [0, -24],
        className: 'bwr-pin-label',
      }).openTooltip();
    }
  });

  if (Array.isArray(data.center) && typeof data.center[0] === 'number' && typeof data.center[1] === 'number') {
    // Explicit center/zoom — used when the map should stay tight on one
    // small area (e.g. a junction and its radiating trails) instead of
    // zooming out to fit every pin, which would shrink short paths to
    // invisibility.
    map.setView(data.center, typeof data.zoom === 'number' ? data.zoom : 15);
  } else if (latlngs.length === 1) {
    map.setView(latlngs[0], typeof data.zoom === 'number' ? data.zoom : 14);
  } else if (latlngs.length > 1) {
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
