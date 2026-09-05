// map-reviews.js — per-trail reviews (star rating + public comments) shown inside
// the path popup on the map page. Loaded AFTER js/map-paths.js (which calls
// initPathReviews(path) from openPathPopup) and references the shared globals
// `map`, `API_URL`, `showToast`, `getToken`/`authHeader`, `_cachedUser`.
//
// Backend: GET/POST /api/paths/:id/reviews, DELETE /api/paths/:id/reviews/:userId.

// Auth header only when actually signed in (authHeader() would send "Bearer null"
// otherwise, which the server rejects as an invalid session).
function _reviewAuth() {
  return (typeof getToken === 'function' && getToken()) ? authHeader() : {};
}

function _stars(n, max = 5) {
  const full = Math.round(Number(n) || 0);
  return '★★★★★☆☆☆☆☆'.slice(5 - full, 10 - full);
}

function _escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// The empty shell openPathPopup drops into the popup; initPathReviews fills it.
function pathReviewShellHTML(path) {
  return `<div class="popup-reviews" id="reviews-${path.id}">
    <div class="popup-reviews-loading">Chargement des avis…</div>
  </div>`;
}

async function initPathReviews(path) {
  const box = document.getElementById(`reviews-${path.id}`);
  if (!box) return;
  try {
    const res = await fetch(`${API_URL}/api/paths/${path.id}/reviews`, { headers: { ..._reviewAuth() } });
    if (!res.ok) { box.innerHTML = ''; return; }
    const data = await res.json();
    renderReviewBox(box, path, data);
  } catch {
    box.innerHTML = '';
  }
}

function renderReviewBox(box, path, data) {
  const signedIn = !!(typeof getToken === 'function' && getToken());
  const count = data.count || 0;
  const avg = data.avg || 0;

  const header = count > 0
    ? `<div class="popup-reviews-summary"><span class="rv-stars">${_stars(avg)}</span>
         <strong>${avg.toFixed(1)}</strong><span class="rv-count">· ${count} avis</span></div>`
    : `<div class="popup-reviews-summary rv-empty">Aucun avis — soyez le premier !</div>`;

  const list = (data.reviews || []).slice(0, 3).map(rv => `
    <div class="rv-item">
      <div class="rv-item-head">
        <span class="rv-stars rv-stars-sm">${_stars(rv.stars)}</span>
        <span class="rv-name">${_escapeHtml(rv.name || 'Anonyme')}</span>
      </div>
      ${rv.comment ? `<div class="rv-comment">${_escapeHtml(rv.comment)}</div>` : ''}
    </div>`).join('');

  const more = count > 3 ? `<div class="rv-more">+ ${count - 3} autre${count - 3 > 1 ? 's' : ''}</div>` : '';

  const action = signedIn
    ? `<button class="rv-btn" id="rvOpen-${path.id}">${data.mine ? '✎ Modifier mon avis' : '★ Donner mon avis'}</button>`
    : `<a class="rv-btn rv-btn-login" href="login">Connectez-vous pour laisser un avis</a>`;

  box.innerHTML = `
    <div class="popup-reviews-title">💬 Avis sur ce chemin</div>
    ${header}
    ${list}
    ${more}
    ${action}
  `;

  box.querySelector(`#rvOpen-${path.id}`)?.addEventListener('click', () => openReviewForm(box, path, data.mine));
}

function openReviewForm(box, path, mine) {
  let chosen = mine?.stars || 0;
  const starBtns = [1, 2, 3, 4, 5].map(n =>
    `<button type="button" class="rv-star-btn" data-star="${n}" aria-label="${n} étoile${n > 1 ? 's' : ''}">☆</button>`
  ).join('');

  box.innerHTML = `
    <div class="popup-reviews-title">${mine ? 'Modifier mon avis' : 'Votre avis'}</div>
    <div class="rv-star-picker" id="rvPicker-${path.id}">${starBtns}</div>
    <textarea class="rv-textarea" id="rvComment-${path.id}" rows="3" maxlength="1000"
      placeholder="Votre ressenti sur ce chemin (facultatif)…">${_escapeHtml(mine?.comment || '')}</textarea>
    <div class="rv-form-actions">
      <button class="rv-btn rv-btn-primary" id="rvSubmit-${path.id}">Publier</button>
      <button class="rv-btn rv-btn-ghost" id="rvCancel-${path.id}">Annuler</button>
      ${mine ? `<button class="rv-btn rv-btn-danger" id="rvDelete-${path.id}">Supprimer</button>` : ''}
    </div>
  `;

  const picker = box.querySelector(`#rvPicker-${path.id}`);
  const paint = () => picker.querySelectorAll('.rv-star-btn').forEach(b => {
    b.textContent = Number(b.dataset.star) <= chosen ? '★' : '☆';
    b.classList.toggle('active', Number(b.dataset.star) <= chosen);
  });
  picker.querySelectorAll('.rv-star-btn').forEach(b => {
    b.addEventListener('click', () => { chosen = Number(b.dataset.star); paint(); });
  });
  paint();

  box.querySelector(`#rvCancel-${path.id}`)?.addEventListener('click', () => initPathReviews(path));

  box.querySelector(`#rvSubmit-${path.id}`)?.addEventListener('click', async () => {
    if (chosen < 1 || chosen > 5) { showToast('Choisissez une note de 1 à 5 étoiles.'); return; }
    const comment = box.querySelector(`#rvComment-${path.id}`).value.slice(0, 1000);
    try {
      const res = await fetch(`${API_URL}/api/paths/${path.id}/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ..._reviewAuth() },
        body: JSON.stringify({ stars: chosen, comment }),
      });
      if (res.ok) { showToast('✅ Merci pour votre avis !'); initPathReviews(path); }
      else if (res.status === 401) { showToast('Connectez-vous pour laisser un avis.'); }
      else { const d = await res.json().catch(() => ({})); showToast(d.error || 'Erreur lors de l\'envoi.'); }
    } catch { showToast('Erreur réseau.'); }
  });

  box.querySelector(`#rvDelete-${path.id}`)?.addEventListener('click', async () => {
    if (!confirm('Supprimer votre avis ?')) return;
    const uid = _cachedUser?.id;
    if (!uid) return;
    try {
      const res = await fetch(`${API_URL}/api/paths/${path.id}/reviews/${uid}`, {
        method: 'DELETE', headers: { ..._reviewAuth() },
      });
      if (res.ok) { showToast('Avis supprimé.'); initPathReviews(path); }
      else { showToast('Erreur lors de la suppression.'); }
    } catch { showToast('Erreur réseau.'); }
  });
}
