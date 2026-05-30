import { effectivePlan } from './kv.js';

export async function geocodeAddress(address) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1&countrycodes=fr`;
    const res = await fetch(url, { headers: { 'User-Agent': 'BWR-App/1.0' } });
    const data = await res.json();
    if (data && data[0]) return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
  } catch {}
  return null;
}

export async function fetchWeatherForCoords(lat, lng) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,weather_code,wind_speed_10m,apparent_temperature&timezone=Europe%2FParis`;
    const res = await fetch(url);
    const data = await res.json();
    return {
      temp: data.current?.temperature_2m ?? 15,
      feels: data.current?.apparent_temperature ?? 15,
      code: data.current?.weather_code ?? 0,
      wind: data.current?.wind_speed_10m ?? 10,
    };
  } catch {
    return { temp: 15, feels: 15, code: 0, wind: 10 };
  }
}

export async function generateAISuggestionForUser(env, user, date) {
  const stats = user.stats || {};
  const km = stats.km || 0;
  const routes = stats.routes || 0;

  const typicalKm = km < 5 ? 4 : km < 25 ? 7 : km < 50 ? 12 : km < 100 ? 15 : 18;

  let startLat = 49.35, startLng = 2.90, fromHome = false;
  if (user.homeCoords) {
    startLat = user.homeCoords.lat;
    startLng = user.homeCoords.lng;
    fromHome = true;
  } else if (user.homeAddress && env.ANTHROPIC_API_KEY) {
    const coords = await geocodeAddress(user.homeAddress);
    if (coords) { startLat = coords.lat; startLng = coords.lng; fromHome = true; }
  }

  const weather = await fetchWeatherForCoords(startLat, startLng);
  const month = new Date().getMonth();
  const season = month <= 1 || month === 11 ? 'hiver' : month <= 4 ? 'printemps' : month <= 7 ? 'été' : 'automne';
  const plan = effectivePlan(user);
  const level = plan === 'gold' ? 'expert' : 'intermédiaire';

  const isHot     = weather.temp >= 25;
  const isStormy  = weather.code >= 95;
  const isRainy   = weather.code >= 61 && weather.code <= 82;
  const isWindy   = weather.wind > 30;

  if (!env.ANTHROPIC_API_KEY) {
    return buildFallbackSuggestion(weather, typicalKm, isHot, isStormy, isRainy, isWindy, startLat, startLng, fromHome);
  }

  const weatherDesc = isStormy ? 'orages signalés' : isRainy ? `pluie (code ${weather.code})` : isWindy ? `vent fort ${Math.round(weather.wind)} km/h` : isHot ? `chaleur ${Math.round(weather.temp)}°C` : `agréable ${Math.round(weather.temp)}°C`;
  const homeHint = user.homeAddress ? `L'utilisateur habite "${user.homeAddress}".` : 'Départ depuis la forêt de Compiègne.';

  const prompt = `Tu es un guide expert de la Forêt de Compiègne (France).
Génère UNE suggestion de balade personnalisée en français (2-3 phrases max, 40-60 mots).
Profil randonneur : ${km.toFixed(0)} km total, ${routes} sorties, niveau ${level}, saison ${season}.
Météo aujourd'hui : ${weatherDesc}.
${homeHint}
${isHot ? 'Comme il fait chaud, suggère un sentier ombragé au bord d\'un lac ou d\'un cours d\'eau dans la forêt.' : ''}
${isStormy ? 'Déconseille la sortie et propose une alternative.' : ''}
Distance suggérée : environ ${typicalKm} km.
Inclus le nom d'un lieu réel de la forêt de Compiègne. Réponds uniquement avec la suggestion, sans guillemets.`;

  let icon = isStormy ? '⛈️' : isRainy ? '🌧️' : isWindy ? '💨' : isHot ? '🏖️' : '✅';
  let advice = '';
  let dist = isStormy ? 0 : isRainy ? Math.max(3, typicalKm - 3) : typicalKm;
  const mode = 'loop';

  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 180,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (aiRes.ok) {
      const d = await aiRes.json();
      advice = d.content?.[0]?.text?.trim() || '';
    }
  } catch {}

  if (!advice) return buildFallbackSuggestion(weather, typicalKm, isHot, isStormy, isRainy, isWindy, startLat, startLng, fromHome);

  return { icon, advice, dist, mode, startLat, startLng, fromHome, temp: Math.round(weather.temp), wind: Math.round(weather.wind) };
}

export function buildFallbackSuggestion(weather, typicalKm, isHot, isStormy, isRainy, isWindy, startLat, startLng, fromHome = false) {
  let icon, advice, dist;
  if (isStormy) {
    icon = '⛈️'; dist = 0;
    advice = 'Orages signalés aujourd\'hui — restez en sécurité, ne partez pas en forêt.';
  } else if (isRainy) {
    icon = '🌧️'; dist = Math.max(3, typicalKm - 3);
    advice = `Pluie prévue — sortie courte de ${dist} km conseillée avec un imperméable.`;
  } else if (isWindy) {
    icon = '💨'; dist = Math.max(4, typicalKm - 2);
    advice = `Vent fort (${Math.round(weather.wind)} km/h) — évitez les zones boisées denses, boucle de ${dist} km recommandée.`;
  } else if (isHot) {
    icon = '🏖️'; dist = typicalKm;
    advice = `Chaleur ${Math.round(weather.temp)}°C — partez tôt et privilégiez les sentiers ombragés au bord des étangs de la forêt.`;
  } else {
    icon = '✅'; dist = typicalKm;
    advice = `Conditions idéales — profitez d'une boucle de ${dist} km à travers les beaux sentiers de la forêt de Compiègne.`;
  }
  return { icon, advice, dist, mode: 'loop', startLat, startLng, fromHome, temp: Math.round(weather.temp), wind: Math.round(weather.wind) };
}

export async function generateDailySuggestions(env) {
  const today = new Date().toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' });

  const keys = [];
  let cursor;
  do {
    const page = await env.BWR_KV.list({ prefix: 'user:', limit: 1000, cursor });
    keys.push(...page.keys);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  let ok = 0, skipped = 0;
  const errors = [];

  for (const key of keys) {
    try {
      const raw = await env.BWR_KV.get(key.name);
      if (!raw) { skipped++; continue; }
      const user = JSON.parse(raw);
      const plan = effectivePlan(user);
      if (plan === 'free') { skipped++; continue; }

      const cacheKey = `aisugg:${user.id}:${today}`;
      const existing = await env.BWR_KV.get(cacheKey);
      if (existing) { skipped++; continue; }

      const suggestion = await generateAISuggestionForUser(env, user, today);
      await env.BWR_KV.put(cacheKey, JSON.stringify(suggestion), { expirationTtl: 172800 });
      ok++;

      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      errors.push(`${key.name}: ${err?.message ?? err}`);
    }
  }

  if (errors.length > 0) {
    await fetch('https://ntfy.sh/bwr-ciril8596', {
      method: 'POST',
      headers: { Title: `BWR cron: ${errors.length} erreur(s)`, Priority: 'default', Tags: 'warning' },
      body: `OK: ${ok} | Ignorés: ${skipped} | Erreurs: ${errors.length}\n\n${errors.slice(0, 10).join('\n')}`,
    }).catch(() => {});
  }
}
