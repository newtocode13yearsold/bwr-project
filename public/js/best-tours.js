(() => {
  'use strict';

  const API = window.API_URL || '';
  let allTours = [];
  let activeFilter = 'all';
  let editingId = null;
  let currentImageDataUri = '';
  let isAdmin = false;

  // ── Load tours immediately (never blocked by the auth check) ──────────────
  loadTours();

  // ── Detect admin in parallel; re-render admin controls when it resolves ───
  (async () => {
    const token = localStorage.getItem('bwr_token');
    if (!token) return;
    try {
      const res = await fetch(`${API}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) {
        const user = await res.json();
        if (user?.role === 'admin') {
          isAdmin = true;
          document.getElementById('fabAdd').style.display = 'flex';
          document.getElementById('navDrawerAdmin')?.classList.remove('hidden');
          renderTours(); // re-render so the edit/delete rows appear
        }
      }
    } catch {}
  })();

  // ── Load tours ────────────────────────────────────────────────────────────
  async function loadTours() {
    try {
      const res = await fetch(`${API}/api/besttours`);
      allTours = res.ok ? await res.json() : [];
    } catch { allTours = []; }
    renderTours();
  }

  // ── Filters ───────────────────────────────────────────────────────────────
  document.getElementById('filtersBar').addEventListener('click', e => {
    const btn = e.target.closest('.filter-btn');
    if (!btn) return;
    activeFilter = btn.dataset.filter;
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderTours();
  });

  function filteredTours() {
    if (activeFilter === 'all') return allTours;
    if (activeFilter.startsWith('diff:')) {
      const d = activeFilter.split(':')[1];
      return allTours.filter(t => t.difficulty === d);
    }
    if (activeFilter.startsWith('type:')) {
      const ty = activeFilter.split(':')[1];
      return allTours.filter(t => t.type === ty);
    }
    return allTours;
  }

  // ── Render ────────────────────────────────────────────────────────────────
  const DIFF_LABEL = { easy: 'Facile', medium: 'Moyen', hard: 'Difficile' };
  const DIFF_CLASS = { easy: 'tour-badge-easy', medium: 'tour-badge-medium', hard: 'tour-badge-hard' };
  const TYPE_LABEL = { foot: '🌲 Pédestre', bike: '🚴 Vélo', mix: '🗺️ Mix' };

  function renderTours() {
    const list = filteredTours();
    const el = document.getElementById('toursList');
    const countEl = document.getElementById('toursCount');

    countEl.textContent = list.length
      ? `${list.length} balade${list.length > 1 ? 's' : ''}`
      : '';

    if (!list.length) {
      el.innerHTML = `<div class="tours-empty"><div class="tours-empty-icon">🌲</div><p>Aucune balade pour ce filtre.</p></div>`;
      return;
    }

    el.innerHTML = list.map((t, i) => {
      const imgSrc = t.imageDataUri || t.imageUrl;
      const imgHtml = imgSrc
        ? `<img class="tour-card-img" src="${escHtml(imgSrc)}" alt="${escHtml(t.name)}" loading="lazy" />`
        : `<div class="tour-card-img-placeholder">🌲</div>`;

      const rankBadge = (t.rank && t.rank < 9999)
        ? `<span class="tour-rank">#${t.rank}</span>` : '';

      const distBadge = t.distance
        ? `<span class="tour-badge tour-badge-dist">📏 ${t.distance} km</span>` : '';

      const startHtml = t.startAddress
        ? `<div class="tour-start"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>${escHtml(t.startAddress)}</div>` : '';

      const planUrl = (t.startLat && t.startLng)
        ? `routes?lat=${t.startLat}&lng=${t.startLng}&distance=${t.distance || 10}&mode=loop&type=${t.type || 'foot'}&diff=${t.difficulty || 'easy'}`
        : `routes${t.startAddress ? `?start=${encodeURIComponent(t.startAddress)}` : ''}`;
      const extBtn = t.externalUrl
        ? `<a class="btn-external" href="${escHtml(t.externalUrl)}" target="_blank" rel="noopener">Voir le tracé <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" x2="21" y1="14" y2="3"/></svg></a>` : '';

      const adminRow = isAdmin
        ? `<div class="tour-admin-row">
             <button class="tour-btn-edit" data-id="${t.id}">Modifier</button>
             <button class="tour-btn-delete" data-id="${t.id}">Supprimer</button>
           </div>` : '';

      return `<article class="tour-card" data-id="${t.id}">
        ${imgHtml}
        <div class="tour-card-body">
          ${rankBadge}
          <div class="tour-badges">
            <span class="tour-badge ${DIFF_CLASS[t.difficulty] || ''}">${DIFF_LABEL[t.difficulty] || t.difficulty}</span>
            <span class="tour-badge tour-badge-type">${TYPE_LABEL[t.type] || t.type}</span>
            ${distBadge}
          </div>
          <h2 class="tour-name">${escHtml(t.name)}</h2>
          ${startHtml}
          ${t.description ? `<p class="tour-description">${escHtml(t.description)}</p>` : ''}
          <div class="tour-actions">
            <a class="btn-plan" href="${planUrl}">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>
              Planifier ce trajet
            </a>
            ${extBtn}
          </div>
          ${adminRow}
        </div>
      </article>`;
    }).join('');

    // Admin event listeners
    if (isAdmin) {
      el.querySelectorAll('.tour-btn-edit').forEach(btn => {
        btn.addEventListener('click', () => openEditModal(btn.dataset.id));
      });
      el.querySelectorAll('.tour-btn-delete').forEach(btn => {
        btn.addEventListener('click', () => deleteTour(btn.dataset.id));
      });
    }
  }

  function escHtml(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Delete ─────────────────────────────────────────────────────────────────
  async function deleteTour(id) {
    if (!confirm('Supprimer cette balade ?')) return;
    const token = typeof getToken === 'function' ? getToken() : localStorage.getItem('bwr_token');
    const res = await fetch(`${API}/api/besttours/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (res.ok) {
      allTours = allTours.filter(t => t.id !== id);
      renderTours();
    } else {
      alert('Erreur lors de la suppression.');
    }
  }

  // ── Modal ─────────────────────────────────────────────────────────────────
  const modal = document.getElementById('modalBackdrop');
  const modalTitle = document.getElementById('modalTitle');
  const fName = document.getElementById('fName');
  const fDiff = document.getElementById('fDifficulty');
  const fType = document.getElementById('fType');
  const fDist = document.getElementById('fDistance');
  const fRank = document.getElementById('fRank');
  const fStart = document.getElementById('fStart');
  const fDesc = document.getElementById('fDesc');
  const fExtUrl = document.getElementById('fExtUrl');
  const modalError = document.getElementById('modalError');
  const imgFileInput = document.getElementById('imgFileInput');
  const imgPreviewWrap = document.getElementById('imgPreviewWrap');
  const imgPreview = document.getElementById('imgPreview');
  const imgRemoveBtn = document.getElementById('imgRemoveBtn');

  function openAddModal() {
    editingId = null;
    currentImageDataUri = '';
    modalTitle.textContent = 'Ajouter une balade';
    fName.value = '';
    fDiff.value = 'easy';
    fType.value = 'foot';
    fDist.value = '';
    fRank.value = '';
    fStart.value = '';
    fDesc.value = '';
    fExtUrl.value = '';
    imgPreviewWrap.style.display = 'none';
    imgPreview.src = '';
    modalError.textContent = '';
    modal.classList.add('open');
    fName.focus();
  }

  function openEditModal(id) {
    const t = allTours.find(x => x.id === id);
    if (!t) return;
    editingId = id;
    currentImageDataUri = t.imageDataUri || '';
    modalTitle.textContent = 'Modifier la balade';
    fName.value = t.name || '';
    fDiff.value = t.difficulty || 'easy';
    fType.value = t.type || 'foot';
    fDist.value = t.distance ?? '';
    fRank.value = (t.rank && t.rank < 9999) ? t.rank : '';
    fStart.value = t.startAddress || '';
    fDesc.value = t.description || '';
    fExtUrl.value = t.externalUrl || '';
    if (currentImageDataUri || t.imageUrl) {
      imgPreview.src = currentImageDataUri || t.imageUrl;
      imgPreviewWrap.style.display = 'block';
    } else {
      imgPreviewWrap.style.display = 'none';
      imgPreview.src = '';
    }
    modalError.textContent = '';
    modal.classList.add('open');
    fName.focus();
  }

  function closeModal() {
    modal.classList.remove('open');
  }

  document.getElementById('fabAdd').addEventListener('click', openAddModal);
  document.getElementById('modalClose').addEventListener('click', closeModal);
  document.getElementById('modalCancel').addEventListener('click', closeModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

  // Image upload
  imgFileInput.addEventListener('change', () => {
    const file = imgFileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        const MAX = 900;
        const canvas = document.createElement('canvas');
        const ratio = Math.min(1, MAX / Math.max(img.width, img.height));
        canvas.width = Math.round(img.width * ratio);
        canvas.height = Math.round(img.height * ratio);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        currentImageDataUri = canvas.toDataURL('image/jpeg', 0.82);
        imgPreview.src = currentImageDataUri;
        imgPreviewWrap.style.display = 'block';
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });

  imgRemoveBtn.addEventListener('click', () => {
    currentImageDataUri = '';
    imgPreview.src = '';
    imgPreviewWrap.style.display = 'none';
    imgFileInput.value = '';
  });

  // Save
  document.getElementById('modalSave').addEventListener('click', async () => {
    const name = fName.value.trim();
    if (!name) { modalError.textContent = 'Le titre est obligatoire.'; return; }
    modalError.textContent = '';

    const saveBtn = document.getElementById('modalSave');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Enregistrement…';

    const token = typeof getToken === 'function' ? getToken() : localStorage.getItem('bwr_token');
    const body = {
      name,
      difficulty: fDiff.value,
      type: fType.value,
      distance: fDist.value ? parseFloat(fDist.value) : null,
      rank: fRank.value ? parseInt(fRank.value) : 9999,
      startAddress: fStart.value.trim(),
      description: fDesc.value.trim(),
      externalUrl: fExtUrl.value.trim(),
      imageDataUri: currentImageDataUri,
    };

    const url = editingId ? `${API}/api/besttours/${editingId}` : `${API}/api/besttours`;
    const method = editingId ? 'PUT' : 'POST';

    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) { modalError.textContent = data.error || 'Erreur serveur.'; return; }

      if (editingId) {
        allTours = allTours.map(t => t.id === editingId ? data : t);
      } else {
        allTours.push(data);
        allTours.sort((a, b) => {
          const ra = a.rank ?? 9999, rb = b.rank ?? 9999;
          if (ra !== rb) return ra - rb;
          return (b.createdAt || '').localeCompare(a.createdAt || '');
        });
      }
      renderTours();
      closeModal();
    } catch {
      modalError.textContent = 'Erreur réseau.';
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Enregistrer';
    }
  });
})();
