// ── Communauté — social / friends layer ──────────────────────────────────────
// Three tabs: the feed (shared walks from people I follow), a discover directory
// to find & follow other randonneurs, and "mon réseau" (following / followers).
// Kudos (applause) + an inline Leaflet replay of any shared walk.
// External file: the site CSP is `script-src 'self'`.
(function () {
  'use strict';

  const content = document.getElementById('frContent');
  if (!content) return;

  // ── helpers ────────────────────────────────────────────────────────────────
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const fmtKm = (m) => (m / 1000).toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' km';

  function fmtDuration(s) {
    s = Math.max(0, Math.round(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    if (h > 0) return `${h} h ${String(m).padStart(2, '0')}`;
    if (m > 0) return `${m} min`;
    return `${s} s`;
  }

  function fmtPace(meters, seconds) {
    if (!meters || !seconds) return '—';
    const p = seconds / (meters / 1000);
    const m = Math.floor(p / 60), s = Math.round(p % 60);
    return `${m}′${String(s).padStart(2, '0')}″/km`;
  }

  // Relative "il y a …" for feed timestamps.
  function fmtAgo(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const sec = Math.round((Date.now() - d.getTime()) / 1000);
    if (sec < 60) return "à l'instant";
    const min = Math.round(sec / 60);
    if (min < 60) return `il y a ${min} min`;
    const h = Math.round(min / 60);
    if (h < 24) return `il y a ${h} h`;
    const days = Math.round(h / 24);
    if (days < 7) return `il y a ${days} j`;
    return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  }

  const initials = (name) => String(name || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();

  async function api(path, opts = {}) {
    const res = await fetch(`${API_URL}${path}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...authHeader(), ...(opts.headers || {}) },
    });
    if (!res.ok) throw new Error(`${res.status}`);
    return res.json();
  }

  // ── tab state ──────────────────────────────────────────────────────────────
  let currentTab = 'feed';
  let networkSub = 'following';

  const tabs = document.querySelectorAll('.fr-tab');
  tabs.forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  function switchTab(tab) {
    currentTab = tab;
    tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    if (tab === 'feed') loadFeed();
    else if (tab === 'discover') loadDiscover();
    else loadNetwork();
  }

  // ── FEED ───────────────────────────────────────────────────────────────────
  async function loadFeed() {
    content.innerHTML = '<div class="fr-loading">Chargement du fil…</div>';
    let data;
    try { data = await api('/api/social/feed'); } catch { return err(); }
    const feed = data.feed || [];
    if (!feed.length) {
      content.innerHTML = `
        <div class="fr-empty">
          <h2>Votre fil est encore vide</h2>
          <p>Suivez des randonneurs dans l'onglet <a href="#" data-goto="discover">Découvrir</a>,
          ou partagez vos propres sorties depuis <a href="activities">Mes sorties</a>.</p>
        </div>`;
      return;
    }
    content.innerHTML = feed.map(feedCard).join('');
  }

  function feedCard(a) {
    const asc = a.ascent ? `<div class="fr-stat"><b>↑ ${a.ascent} m</b><span>Dénivelé</span></div>` : '';
    const on = a.iKudosed ? ' on' : '';
    return `
      <div class="fr-card fr-feed-card" data-owner="${esc(a.ownerId)}" data-act="${esc(a.id)}">
        <div class="fr-feed-head">
          <div class="fr-feed-av">${esc(initials(a.ownerName))}</div>
          <div>
            <div class="fr-feed-who">${esc(a.ownerName)}</div>
            <div class="fr-feed-when">${esc(fmtAgo(a.startedAt || a.savedAt))}</div>
          </div>
        </div>
        <div class="fr-feed-name">${esc(a.name)}</div>
        <div class="fr-stats">
          <div class="fr-stat"><b>${fmtKm(a.meters)}</b><span>Distance</span></div>
          <div class="fr-stat"><b>${fmtDuration(a.seconds)}</b><span>Durée</span></div>
          <div class="fr-stat"><b>${fmtPace(a.meters, a.movingSeconds || a.seconds)}</b><span>Allure</span></div>
          ${asc}
        </div>
        <div class="fr-feed-actions">
          <button class="fr-kudos${on}" data-role="kudos"><span data-role="clap">👏</span> <span data-role="kcount">${a.kudos || 0}</span></button>
          <button class="fr-btn ghost" data-role="replay">▶ Rejouer</button>
        </div>
      </div>`;
  }

  async function toggleKudos(ownerId, actId, btn) {
    btn.disabled = true;
    try {
      const res = await api(`/api/social/kudos/${encodeURIComponent(ownerId)}/${encodeURIComponent(actId)}`, { method: 'POST' });
      btn.classList.toggle('on', res.mine);
      btn.querySelector('[data-role="kcount"]').textContent = res.kudos;
    } catch { /* ignore */ } finally { btn.disabled = false; }
  }

  // ── DISCOVER ───────────────────────────────────────────────────────────────
  let searchTimer = null;
  async function loadDiscover(q = '') {
    if (!content.querySelector('#frSearch')) {
      content.innerHTML = `
        <input type="search" id="frSearch" class="fr-search" placeholder="Rechercher un randonneur par nom ou pseudo…" autocomplete="off" />
        <div id="frDirList"><div class="fr-loading">Chargement…</div></div>`;
      const input = content.querySelector('#frSearch');
      input.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => loadDiscover(input.value.trim()), 300);
      });
    }
    const list = content.querySelector('#frDirList');
    list.innerHTML = '<div class="fr-loading">Recherche…</div>';
    let data;
    try { data = await api(`/api/social/users${q ? `?q=${encodeURIComponent(q)}` : ''}`); } catch { list.innerHTML = errHtml(); return; }
    const users = data.users || [];
    if (!users.length) {
      list.innerHTML = `<div class="fr-empty"><p>${q ? 'Aucun randonneur trouvé.' : 'Aucun autre randonneur pour l\'instant.'}</p></div>`;
      return;
    }
    list.innerHTML = users.map(personCard).join('');
  }

  function personCard(u) {
    const sub = [u.username ? `@${u.username}` : null, u.walkedPathsCount ? `${u.walkedPathsCount} chemins parcourus` : null].filter(Boolean).join(' · ');
    const btn = u.isFollowing
      ? `<button class="fr-btn ghost" data-role="unfollow">✓ Abonné</button>`
      : `<button class="fr-btn primary" data-role="follow">+ Suivre</button>`;
    return `
      <div class="fr-card fr-person" data-uid="${esc(u.id)}">
        <div class="fr-avatar">${esc(initials(u.name))}</div>
        <div class="fr-person-main">
          <div class="fr-person-name">${esc(u.name)}</div>
          <div class="fr-person-sub">${esc(sub || 'Randonneur BWR')}</div>
        </div>
        ${btn}
      </div>`;
  }

  async function setFollow(uid, follow, cardEl) {
    const btn = cardEl.querySelector('[data-role="follow"], [data-role="unfollow"]');
    if (btn) btn.disabled = true;
    try {
      await api(`/api/social/follow/${encodeURIComponent(uid)}`, { method: follow ? 'POST' : 'DELETE' });
      if (btn) {
        btn.outerHTML = follow
          ? `<button class="fr-btn ghost" data-role="unfollow">✓ Abonné</button>`
          : `<button class="fr-btn primary" data-role="follow">+ Suivre</button>`;
      }
    } catch { if (btn) btn.disabled = false; }
  }

  // ── NETWORK (following / followers) ─────────────────────────────────────────
  async function loadNetwork() {
    content.innerHTML = `
      <div class="fr-sub-tabs">
        <button class="fr-sub-tab ${networkSub === 'following' ? 'active' : ''}" data-sub="following">Abonnements</button>
        <button class="fr-sub-tab ${networkSub === 'followers' ? 'active' : ''}" data-sub="followers">Abonnés</button>
      </div>
      <div id="frNetList"><div class="fr-loading">Chargement…</div></div>`;
    content.querySelectorAll('.fr-sub-tab').forEach(b =>
      b.addEventListener('click', () => { networkSub = b.dataset.sub; loadNetwork(); }));

    const list = content.querySelector('#frNetList');
    const path = networkSub === 'following' ? '/api/social/following' : '/api/social/followers';
    let data;
    try { data = await api(path); } catch { list.innerHTML = errHtml(); return; }
    const users = data.users || [];
    if (!users.length) {
      list.innerHTML = networkSub === 'following'
        ? `<div class="fr-empty"><p>Vous ne suivez encore personne. <a href="#" data-goto="discover">Trouvez des randonneurs à suivre.</a></p></div>`
        : `<div class="fr-empty"><p>Personne ne vous suit encore. Partagez vos sorties pour attirer des abonnés !</p></div>`;
      return;
    }
    list.innerHTML = users.map(u => networkCard(u, networkSub)).join('');
  }

  function networkCard(u, sub) {
    const subtitle = u.username ? `@${u.username}` : 'Randonneur BWR';
    let btn;
    if (sub === 'following') {
      btn = `<button class="fr-btn ghost" data-role="unfollow">Se désabonner</button>`;
    } else {
      btn = u.iFollow
        ? `<button class="fr-btn ghost" data-role="unfollow">✓ Abonné</button>`
        : `<button class="fr-btn primary" data-role="follow">Suivre en retour</button>`;
    }
    return `
      <div class="fr-card fr-person" data-uid="${esc(u.id)}">
        <div class="fr-avatar">${esc(initials(u.name))}</div>
        <div class="fr-person-main">
          <div class="fr-person-name">${esc(u.name)}</div>
          <div class="fr-person-sub">${esc(subtitle)}</div>
        </div>
        ${btn}
      </div>`;
  }

  // ── shared error UI ──────────────────────────────────────────────────────────
  const errHtml = () => '<div class="fr-empty"><p>Impossible de charger. Vérifiez votre connexion et réessayez.</p></div>';
  function err() { content.innerHTML = errHtml(); }

  // ── delegated clicks ─────────────────────────────────────────────────────────
  content.addEventListener('click', (e) => {
    const goto = e.target.closest('[data-goto]');
    if (goto) { e.preventDefault(); switchTab(goto.dataset.goto); return; }

    const feedCardEl = e.target.closest('.fr-feed-card');
    if (feedCardEl) {
      const role = e.target.closest('[data-role]')?.dataset.role;
      if (role === 'kudos') return toggleKudos(feedCardEl.dataset.owner, feedCardEl.dataset.act, e.target.closest('.fr-kudos'));
      if (role === 'replay') return openReplay(feedCardEl.dataset.owner, feedCardEl.dataset.act);
      // Tapping the author's avatar/name opens their public profile.
      if (e.target.closest('.fr-feed-head')) return openProfile(feedCardEl.dataset.owner);
    }

    const personEl = e.target.closest('.fr-person');
    if (personEl) {
      const role = e.target.closest('[data-role]')?.dataset.role;
      if (role === 'follow')   return setFollow(personEl.dataset.uid, true, personEl);
      if (role === 'unfollow') return setFollow(personEl.dataset.uid, false, personEl);
      // A tap anywhere else on the card opens the person's public profile.
      return openProfile(personEl.dataset.uid);
    }
  });

  // ── PROFILE (a person's public / shared activities) ──────────────────────────
  const profileOverlay = document.getElementById('profileOverlay');
  const profileBody = document.getElementById('profileBody');
  let profileUid = null;

  function closeProfile() { profileOverlay.classList.remove('open'); }

  async function openProfile(uid) {
    if (!uid) return;
    profileUid = uid;
    document.getElementById('profileTitle').textContent = 'Profil';
    profileBody.innerHTML = '<div class="fr-loading">Chargement…</div>';
    profileOverlay.classList.add('open');
    let p;
    try { p = await api(`/api/social/profile/${encodeURIComponent(uid)}`); }
    catch { profileBody.innerHTML = errHtml(); return; }
    renderProfile(p);
  }

  function renderProfile(p) {
    document.getElementById('profileTitle').textContent = p.name || 'Profil';
    const acts = p.sharedActivities || [];
    const followBtn = p.isMe ? ''
      : p.isFollowing
        ? `<button class="fr-btn ghost" data-role="pf-unfollow">✓ Abonné</button>`
        : `<button class="fr-btn primary" data-role="pf-follow">+ Suivre</button>`;
    const km = (p.stats && p.stats.km) ? Number(p.stats.km).toLocaleString('fr-FR') : 0;
    const actsHtml = acts.length
      ? acts.map(a => `
          <div class="fr-act">
            <div class="fr-act-main">
              <div class="fr-act-name">${esc(a.name || 'Sortie')}</div>
              <div class="fr-act-meta">${fmtKm(a.meters)} · ${fmtDuration(a.seconds)} · ${esc(fmtAgo(a.startedAt || a.savedAt))}</div>
            </div>
            <button class="fr-btn ghost" data-role="pf-replay" data-act="${esc(a.id)}">▶ Rejouer</button>
          </div>`).join('')
      : `<div class="fr-empty" style="padding:24px 0"><p>${p.isMe ? "Vous n'avez pas encore partagé de sortie." : "Cette personne n'a pas encore partagé de sortie publique."}</p></div>`;
    profileBody.innerHTML = `
      <div class="fr-profile-top">
        <div class="fr-avatar">${esc(initials(p.name))}</div>
        <div class="fr-person-main">
          <div class="fr-person-name">${esc(p.name)}</div>
          <div class="fr-person-sub">${p.username ? '@' + esc(p.username) : 'Randonneur BWR'}</div>
        </div>
        ${followBtn}
      </div>
      <div class="fr-profile-counts">
        <div><b>${p.followerCount || 0}</b><span>Abonnés</span></div>
        <div><b>${p.followingCount || 0}</b><span>Abonnements</span></div>
        <div><b>${km}</b><span>km</span></div>
      </div>
      <div class="fr-profile-h">Sorties publiques (${acts.length})</div>
      ${actsHtml}`;
  }

  async function profileFollow(follow) {
    try {
      await api(`/api/social/follow/${encodeURIComponent(profileUid)}`, { method: follow ? 'POST' : 'DELETE' });
      const p = await api(`/api/social/profile/${encodeURIComponent(profileUid)}`);
      renderProfile(p);
      // Keep the list behind the modal in sync.
      if (currentTab === 'discover') {
        const s = content.querySelector('#frSearch');
        loadDiscover(s ? s.value.trim() : '');
      } else if (currentTab === 'network') loadNetwork();
      else if (currentTab === 'feed') loadFeed();
    } catch { /* ignore */ }
  }

  profileOverlay.addEventListener('click', (e) => {
    if (e.target === profileOverlay) return closeProfile();
    const role = e.target.closest('[data-role]')?.dataset.role;
    if (role === 'pf-follow')   return profileFollow(true);
    if (role === 'pf-unfollow') return profileFollow(false);
    if (role === 'pf-replay') {
      const actId = e.target.closest('[data-role]').dataset.act;
      closeProfile();               // avoid stacking two overlays
      return openReplay(profileUid, actId);
    }
  });
  document.getElementById('profileClose').addEventListener('click', closeProfile);

  // ── replay modal (shared walk track) ─────────────────────────────────────────
  const overlay = document.getElementById('replayOverlay');
  const replay = { map: null, marker: null, fullLine: null, doneLine: null, coords: [], raf: null, playing: false, progress: 0 };
  const scrub = document.getElementById('replayScrub');
  const timeLbl = document.getElementById('replayTime');
  const playBtn = document.getElementById('replayPlay');

  function closeReplay() {
    replay.playing = false;
    if (replay.raf) cancelAnimationFrame(replay.raf);
    overlay.classList.remove('open');
  }

  async function openReplay(ownerId, actId) {
    let full;
    try { full = await api(`/api/social/activity/${encodeURIComponent(ownerId)}/${encodeURIComponent(actId)}`); }
    catch { return; }
    const coords = (full.coords || []).map(c => [c[0], c[1]]);
    if (coords.length < 2) return;

    document.getElementById('replayTitle').textContent = `${full.name || 'Sortie'} — ${full.ownerName || ''}`.trim();
    overlay.classList.add('open');
    replay.coords = coords;

    if (!replay.map) {
      replay.map = L.map('replayMap', { zoomControl: true });
      L.tileLayer('/tiles/topo/{z}/{x}/{y}.png', {
        attribution: 'Map data: © OpenStreetMap contributors, SRTM | © OpenTopoMap',
        maxNativeZoom: 15, maxZoom: 17,
      }).addTo(replay.map);
    }
    setTimeout(() => replay.map.invalidateSize(), 60);

    if (replay.fullLine) replay.map.removeLayer(replay.fullLine);
    if (replay.doneLine) replay.map.removeLayer(replay.doneLine);
    if (replay.marker) replay.map.removeLayer(replay.marker);

    replay.fullLine = L.polyline(coords, { color: '#9ca3af', weight: 4, opacity: 0.55 }).addTo(replay.map);
    replay.doneLine = L.polyline([], { color: '#1e4d14', weight: 5 }).addTo(replay.map);
    replay.marker = L.circleMarker(coords[0], { radius: 8, color: '#fff', weight: 2, fillColor: '#1e4d14', fillOpacity: 1 }).addTo(replay.map);
    replay.map.fitBounds(replay.fullLine.getBounds(), { padding: [30, 30] });

    setProgress(0);
    setPlaying(false);
  }

  function setProgress(p) {
    replay.progress = Math.min(1, Math.max(0, p));
    const coords = replay.coords, n = coords.length;
    const idx = Math.floor(replay.progress * (n - 1));
    if (replay.doneLine) replay.doneLine.setLatLngs(coords.slice(0, idx + 1));
    const cur = coords[Math.min(idx, n - 1)];
    if (replay.marker && cur) replay.marker.setLatLng(cur);
    scrub.value = String(Math.round(replay.progress * 1000));
    timeLbl.textContent = `${Math.round(replay.progress * 100)} %`;
  }

  function setPlaying(on) {
    replay.playing = on;
    playBtn.textContent = on ? '⏸' : '▶';
    if (on) {
      if (replay.progress >= 1) setProgress(0);
      let last = performance.now();
      const DURATION = 12000;
      const step = (now) => {
        if (!replay.playing) return;
        const dt = now - last; last = now;
        setProgress(replay.progress + dt / DURATION);
        if (replay.progress >= 1) { setPlaying(false); return; }
        replay.raf = requestAnimationFrame(step);
      };
      replay.raf = requestAnimationFrame(step);
    } else if (replay.raf) {
      cancelAnimationFrame(replay.raf);
    }
  }

  playBtn.addEventListener('click', () => setPlaying(!replay.playing));
  scrub.addEventListener('input', () => { setPlaying(false); setProgress(scrub.value / 1000); });
  document.getElementById('replayClose').addEventListener('click', closeReplay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeReplay(); });

  // ── boot ─────────────────────────────────────────────────────────────────────
  (async function boot() {
    const user = await requireAuth();
    if (!user) return;
    loadFeed();
  })();
})();
