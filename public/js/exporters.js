/* ── BWR Route Exporters ──────────────────────────────────────────────────────
 *
 * Pure-functional GPX/KML generation + download helpers. Used by routes.js.
 *
 * Usage:
 *   const gpx = routeToGPX(coords, { name: 'My loop' });
 *   downloadFile(gpx, 'my-loop.gpx', 'application/gpx+xml');
 *
 *   // Strava / Komoot push: generate GPX, open the upload page with it.
 *   pushToStrava(coords, name);
 * ────────────────────────────────────────────────────────────────────────────── */

(function (global) {
  'use strict';

  function escapeXml(s) {
    return String(s)
      .replace(/&/g,  '&amp;')
      .replace(/</g,  '&lt;')
      .replace(/>/g,  '&gt;')
      .replace(/"/g,  '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * @param {Array<[number, number]>} coords  Array of [lat, lon] pairs.
   * @param {Object} opts                     { name, description, elevations? }
   * @returns {string}                        GPX 1.1 XML.
   */
  function routeToGPX(coords, opts = {}) {
    const name = escapeXml(opts.name || 'BWR Route');
    const desc = escapeXml(opts.description || 'Itinéraire généré par BWR — Carte interactive de l\'Oise');
    const elevs = opts.elevations || null;
    const now = new Date().toISOString();

    const trkpts = coords.map(([lat, lon], i) => {
      const ele = elevs && elevs[i] !== undefined
        ? `      <ele>${(+elevs[i]).toFixed(1)}</ele>\n`
        : '';
      return `    <trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}">\n${ele}    </trkpt>`;
    }).join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="BWR — Carte interactive de l'Oise"
     xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${name}</name>
    <desc>${desc}</desc>
    <time>${now}</time>
  </metadata>
  <trk>
    <name>${name}</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`;
  }

  /**
   * @param {Array<[number, number]>} coords  Array of [lat, lon] pairs.
   * @param {Object} opts                     { name, description, color? }
   * @returns {string}                        KML 2.2 XML (Google Earth-ready).
   */
  function routeToKML(coords, opts = {}) {
    const name = escapeXml(opts.name || 'BWR Route');
    const desc = escapeXml(opts.description || 'Itinéraire généré par BWR');
    // KML colors are aabbggrr (alpha-blue-green-red). Default = forest green at 70 % opacity.
    const color = opts.color || 'b3144d1e';

    const coordsStr = coords
      .map(([lat, lon]) => `${lon.toFixed(6)},${lat.toFixed(6)},0`)
      .join(' ');

    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${name}</name>
    <description>${desc}</description>
    <Style id="bwrPath">
      <LineStyle>
        <color>${color}</color>
        <width>5</width>
      </LineStyle>
    </Style>
    <Placemark>
      <name>${name}</name>
      <description>${desc}</description>
      <styleUrl>#bwrPath</styleUrl>
      <LineString>
        <tessellate>1</tessellate>
        <coordinates>${coordsStr}</coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>`;
  }

  /**
   * Parse a GPX file (Strava / Garmin / Komoot export) into a BWR route.
   * Reads track points (<trkpt>) first, falling back to route points (<rtept>).
   * Multiple <trkseg> segments are concatenated in document order.
   *
   * @param {string} xml  Raw GPX XML text.
   * @returns {{ coords: Array<[number, number]>, elevations: number[]|null, name: string }}
   * @throws {Error} if the file isn't valid GPX or has no usable points.
   */
  function parseGPX(xml) {
    if (typeof DOMParser === 'undefined') throw new Error('DOMParser indisponible');
    const doc = new DOMParser().parseFromString(String(xml), 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('Fichier GPX illisible.');
    if (doc.documentElement.nodeName.toLowerCase() !== 'gpx') {
      throw new Error('Ce fichier n\'est pas un GPX.');
    }

    let pts = Array.from(doc.getElementsByTagName('trkpt'));
    if (!pts.length) pts = Array.from(doc.getElementsByTagName('rtept'));
    if (!pts.length) pts = Array.from(doc.getElementsByTagName('wpt'));

    const coords = [];
    const elevations = [];
    let hasEle = false;
    for (const p of pts) {
      const lat = parseFloat(p.getAttribute('lat'));
      const lon = parseFloat(p.getAttribute('lon'));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      coords.push([lat, lon]);
      const eleEl = p.getElementsByTagName('ele')[0];
      const ele = eleEl ? parseFloat(eleEl.textContent) : NaN;
      if (Number.isFinite(ele)) { elevations.push(ele); hasEle = true; }
      else { elevations.push(null); }
    }

    if (coords.length < 2) throw new Error('Ce GPX ne contient pas de tracé exploitable.');

    const nameEl = doc.querySelector('trk > name') || doc.querySelector('metadata > name') || doc.querySelector('name');
    const name = (nameEl && nameEl.textContent.trim()) || 'Trajet importé';

    return { coords, elevations: hasEle ? elevations : null, name };
  }

  /** Trigger a browser download for a generated text payload. */
  function downloadFile(content, filename, mime = 'application/octet-stream') {
    const blob = new Blob([content], { type: mime });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  /** Convenience wrappers. */
  function downloadGPX(coords, name, extra = {}) {
    const gpx = routeToGPX(coords, { name, ...extra });
    const safe = String(name).replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '') || 'route';
    downloadFile(gpx, `${safe}.gpx`, 'application/gpx+xml');
  }

  function downloadKML(coords, name, extra = {}) {
    const kml = routeToKML(coords, { name, ...extra });
    const safe = String(name).replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '') || 'route';
    downloadFile(kml, `${safe}.kml`, 'application/vnd.google-earth.kml+xml');
  }

  /**
   * Push to Strava: Strava's web upload accepts a GPX file. Since they do not
   * support pre-filled URL upload without OAuth, we download the GPX *and*
   * open the upload page; the user drops/selects the freshly downloaded file.
   * Lightweight MVP — real OAuth integration is on the v2 roadmap.
   */
  function pushToStrava(coords, name) {
    downloadGPX(coords, name);
    setTimeout(() => window.open('https://www.strava.com/upload/select', '_blank'), 250);
  }

  function pushToKomoot(coords, name) {
    downloadGPX(coords, name);
    setTimeout(() => window.open('https://www.komoot.com/upload', '_blank'), 250);
  }

  global.routeToGPX   = routeToGPX;
  global.parseGPX     = parseGPX;
  global.routeToKML   = routeToKML;
  global.downloadFile = downloadFile;
  global.downloadGPX  = downloadGPX;
  global.downloadKML  = downloadKML;
  global.pushToStrava = pushToStrava;
  global.pushToKomoot = pushToKomoot;
})(window);
