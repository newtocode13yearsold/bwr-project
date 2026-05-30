// ── Elevation profile (Open-Elevation API) ────────────────────────────────────
// Lazy-loaded by routes.js on first route generation.

async function fetchElevation(coords) {
  // Sample up to 100 evenly-spaced points to stay under API limits
  const step = Math.max(1, Math.floor(coords.length / 100));
  const sampled = coords.filter((_, i) => i % step === 0);
  if (sampled[sampled.length - 1] !== coords[coords.length - 1])
    sampled.push(coords[coords.length - 1]);

  const locations = sampled.map(([lat, lon]) => ({ latitude: lat, longitude: lon }));
  const res = await fetch('https://api.open-elevation.com/api/v1/lookup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locations }),
  });
  if (!res.ok) throw new Error('elevation API error');
  const data = await res.json();
  return data.results.map(r => r.elevation);
}

function drawElevationChart(elevations, meters) {
  const wrap = document.getElementById('elevationWrap');
  const el = document.getElementById('elevationChart');
  if (!elevations || elevations.length < 2) { wrap.classList.add('hidden'); return; }

  const minE = Math.min(...elevations);
  const maxE = Math.max(...elevations);
  const range = maxE - minE || 1;
  const W = 260, H = 70, PAD = 4;

  const pts = elevations.map((e, i) => {
    const x = PAD + (i / (elevations.length - 1)) * (W - PAD * 2);
    const y = H - PAD - ((e - minE) / range) * (H - PAD * 2);
    return `${x},${y}`;
  });

  const polyFill = `M${pts[0]} ` + pts.slice(1).map(p => `L${p}`).join(' ')
    + ` L${W - PAD},${H - PAD} L${PAD},${H - PAD} Z`;
  const polyLine = `M${pts[0]} ` + pts.slice(1).map(p => `L${p}`).join(' ');

  let ascent = 0, descent = 0;
  for (let i = 1; i < elevations.length; i++) {
    const d = elevations[i] - elevations[i - 1];
    if (d > 0) ascent += d; else descent -= d;
  }

  document.getElementById('statAscent').textContent =
    `+${Math.round(ascent)} m / -${Math.round(descent)} m`;

  el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:${H}px;display:block">
      <path d="${polyFill}" fill="rgba(30,77,20,0.15)" stroke="none"/>
      <path d="${polyLine}" fill="none" stroke="#1e4d14" stroke-width="2" stroke-linejoin="round"/>
      <text x="${PAD}" y="${H - 2}" font-size="9" fill="#6b7280">${Math.round(minE)} m</text>
      <text x="${PAD}" y="10" font-size="9" fill="#6b7280">${Math.round(maxE)} m</text>
      <text x="${W / 2}" y="${H - 2}" font-size="9" fill="#9ca3af" text-anchor="middle">${(meters / 1000).toFixed(1)} km</text>
    </svg>
  `;
  wrap.classList.remove('hidden');
}
