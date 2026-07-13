let currentUser = null;
let allNews = [];
let pendingImageDataUri = '';
let activeFilter = 'all';

// Category catalogue — keep slugs in sync with NEWS_CATEGORIES in worker/handlers/content.js.
const NEWS_CATEGORIES = {
  foret:     { label: 'Forêt',          icon: '🌲' },
  evenement: { label: 'Événement',      icon: '📅' },
  faune:     { label: 'Faune & flore',  icon: '🦌' },
  securite:  { label: 'Sécurité',       icon: '⚠️' },
  travaux:   { label: 'Travaux',        icon: '🚧' },
  app:       { label: 'App BWR',        icon: '📱' },
};
const catOf = (item) => NEWS_CATEGORIES[item.category] ? item.category : 'foret';

async function init() {
  // Try to detect logged-in user (non-blocking — page works without auth)
  try {
    const token = localStorage.getItem('bwr_token');
    if (token) {
      const res = await fetch(`${API_URL}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) currentUser = await res.json();
    }
  } catch {}

  updateNav();
  await loadNews();

  if (currentUser?.role === 'admin') {
    document.getElementById('fabAdd').style.display = 'flex';
  }
}

function updateNav() {
  const loginLink = document.getElementById('navLogin');
  if (!loginLink) return;
  if (currentUser) {
    loginLink.textContent = '👤 ' + (currentUser.name?.split(' ')[0] || 'Profil');
    loginLink.href = 'profile';
  }
}

async function loadNews() {
  const feed = document.getElementById('newsFeed');
  feed.innerHTML = '<div class="news-loading">Chargement…</div>';
  try {
    const res = await fetch(`${API_URL}/api/news`);
    allNews = await res.json();
    renderFeed();
  } catch {
    feed.innerHTML = '<div class="news-empty">Impossible de charger les actualités.</div>';
  }
}

function renderFilters() {
  const bar = document.getElementById('newsFilters');
  if (!bar) return;
  // Only show categories that actually have at least one article.
  const present = new Set(allNews.map(catOf));
  if (!allNews.length) { bar.innerHTML = ''; return; }

  const chips = [`<button class="news-chip ${activeFilter === 'all' ? 'active' : ''}" data-filter="all">Tout</button>`];
  for (const [slug, cat] of Object.entries(NEWS_CATEGORIES)) {
    if (!present.has(slug)) continue;
    chips.push(
      `<button class="news-chip ${activeFilter === slug ? 'active' : ''}" data-filter="${slug}">${cat.icon} ${cat.label}</button>`
    );
  }
  bar.innerHTML = chips.join('');
}

function renderFeed() {
  const feed = document.getElementById('newsFeed');
  renderFilters();
  if (!allNews.length) {
    feed.innerHTML = '<div class="news-empty">Aucune actualité pour l\'instant.</div>';
    return;
  }
  const items = activeFilter === 'all' ? allNews : allNews.filter(n => catOf(n) === activeFilter);
  if (!items.length) {
    feed.innerHTML = '<div class="news-empty">Aucune actualité dans cette catégorie.</div>';
    return;
  }
  feed.innerHTML = items.map(item => newsCard(item)).join('');
  attachFadeObserver();
}

const FOREST_PLACEHOLDERS = ['🌲', '🌳', '🦌', '🍄', '🌿', '🐦'];

function newsCard(item) {
  const date = new Date(item.createdAt).toLocaleDateString('fr-FR', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
  const plan = currentUser?.role === 'admin' ? 'gold' : (currentUser?.plan || 'free');
  const canLink = plan === 'silver' || plan === 'gold';

  // Image or placeholder (uploaded data URI takes priority over external URL)
  const imgSrc = item.imageDataUri || item.imageUrl || '';
  const imgHtml = imgSrc
    ? `<img class="news-img" src="${escHtml(imgSrc)}" alt="${escHtml(item.title)}" loading="lazy" />`
    : `<div class="news-img-placeholder">${FOREST_PLACEHOLDERS[Math.abs(item.id?.charCodeAt(0) ?? 0) % FOREST_PLACEHOLDERS.length]}</div>`;

  // Article body — long articles start collapsed with a "Voir tout" toggle.
  const LONG_CHARS = 420;
  let contentHtml = '';
  if (item.content) {
    const body = escHtml(item.content).replace(/\n/g, '<br>');
    const isLong = item.content.length > LONG_CHARS;
    contentHtml = isLong
      ? `<p class="news-content collapsed" data-content-id="${item.id}">${body}</p>
         <button class="news-readmore" data-more-id="${item.id}">
           <span class="news-readmore-label">Voir tout</span>
           <span class="chev">▾</span>
         </button>`
      : `<p class="news-content">${body}</p>`;
  }

  const linkHtml = item.url
    ? canLink
      ? `<a href="${escHtml(item.url)}" target="_blank" rel="noopener noreferrer" class="news-link">
           ${escHtml(item.urlLabel || 'Lire l\'article')} →
         </a>`
      : `<span class="news-link news-link-locked" title="Réservé aux membres Argent">
           🥈 ${escHtml(item.urlLabel || 'Lire l\'article')} →
         </span>`
    : '';
  const adminControls = currentUser?.role === 'admin'
    ? `<div class="news-admin-row">
         <button class="news-btn-edit" data-edit-id="${item.id}">Modifier</button>
         <button class="news-btn-delete" data-delete-id="${item.id}">Supprimer</button>
       </div>`
    : '';

  // Like / dislike bar — my own choice is remembered locally to highlight the button.
  const myReaction = localStorage.getItem(`bwr_news_react_${item.id}`) || '';
  const reactHtml = `
    <div class="news-reactions">
      <button class="news-react news-like ${myReaction === 'like' ? 'active' : ''}"
              data-react-id="${item.id}" data-react-type="like" aria-label="J'aime">
        <span class="news-react-icon">👍</span>
        <span class="news-react-count" data-like-count="${item.id}">${item.likes || 0}</span>
      </button>
      <button class="news-react news-dislike ${myReaction === 'dislike' ? 'active' : ''}"
              data-react-id="${item.id}" data-react-type="dislike" aria-label="Je n'aime pas">
        <span class="news-react-icon">👎</span>
        <span class="news-react-count" data-dislike-count="${item.id}">${item.dislikes || 0}</span>
      </button>
    </div>`;

  return `
    <article class="news-card fade-up" data-id="${item.id}">
      ${imgHtml}
      <div class="news-meta">
        <span class="news-date">${date}</span>
        <span class="news-cat-badge">${NEWS_CATEGORIES[catOf(item)].icon} ${escHtml(NEWS_CATEGORIES[catOf(item)].label)}</span>
      </div>
      <h2 class="news-title">${escHtml(item.title)}</h2>
      ${contentHtml}
      ${linkHtml}
      ${reactHtml}
      ${adminControls}
    </article>`;
}

// ── Reactions ────────────────────────────────────────────────────────────────

async function reactToNews(id, reaction) {
  const current = localStorage.getItem(`bwr_news_react_${id}`) || '';
  // Clicking the active button again removes the vote (toggle off).
  const next = current === reaction ? null : reaction;

  // Optimistic local highlight.
  if (next) localStorage.setItem(`bwr_news_react_${id}`, next);
  else localStorage.removeItem(`bwr_news_react_${id}`);
  applyReactionState(id, next);

  try {
    const token = localStorage.getItem('bwr_token');
    const res = await fetch(`${API_URL}/api/news/${id}/react`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ reaction: next }),
    });
    if (!res.ok) throw new Error('react failed');
    const data = await res.json();

    const item = allNews.find(n => n.id === id);
    if (item) { item.likes = data.likes; item.dislikes = data.dislikes; }
    updateReactionCounts(id, data.likes, data.dislikes);
  } catch {
    // Revert the optimistic highlight on failure.
    if (current) localStorage.setItem(`bwr_news_react_${id}`, current);
    else localStorage.removeItem(`bwr_news_react_${id}`);
    applyReactionState(id, current || null);
  }
}

function toggleContent(btn) {
  const id = btn.dataset.moreId;
  const p = document.querySelector(`.news-content[data-content-id="${id}"]`);
  if (!p) return;
  const collapsed = p.classList.toggle('collapsed');
  btn.classList.toggle('open', !collapsed);
  btn.querySelector('.news-readmore-label').textContent = collapsed ? 'Voir tout' : 'Réduire';
}

function applyReactionState(id, reaction) {
  const card = document.querySelector(`.news-card[data-id="${id}"]`);
  if (!card) return;
  card.querySelector('.news-like')?.classList.toggle('active', reaction === 'like');
  card.querySelector('.news-dislike')?.classList.toggle('active', reaction === 'dislike');
}

function updateReactionCounts(id, likes, dislikes) {
  const likeEl = document.querySelector(`[data-like-count="${id}"]`);
  const dislikeEl = document.querySelector(`[data-dislike-count="${id}"]`);
  if (likeEl) likeEl.textContent = likes;
  if (dislikeEl) dislikeEl.textContent = dislikes;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Modal ──────────────────────────────────────────────────────────────────

function openAdd() {
  openModal(null);
}

function openEdit(id) {
  const item = allNews.find(n => n.id === id);
  if (item) openModal(item);
}

function openModal(item) {
  document.getElementById('modalTitle').textContent = item ? 'Modifier l\'actualité' : 'Nouvelle actualité';
  document.getElementById('fieldTitle').value = item?.title || '';
  document.getElementById('fieldCategory').value = item ? catOf(item) : 'foret';
  document.getElementById('fieldContent').value = item?.content || '';
  document.getElementById('fieldUrl').value = item?.url || '';
  document.getElementById('fieldUrlLabel').value = item?.urlLabel || '';
  document.getElementById('modalEditId').value = item?.id || '';
  document.getElementById('modalError').textContent = '';

  // Image
  pendingImageDataUri = item?.imageDataUri || '';
  document.getElementById('fieldImage').value = '';
  if (pendingImageDataUri) {
    document.getElementById('imgPreview').src = pendingImageDataUri;
    document.getElementById('imgPreviewWrap').style.display = 'block';
    document.getElementById('imgUploadArea').style.display = 'none';
  } else {
    document.getElementById('imgPreviewWrap').style.display = 'none';
    document.getElementById('imgUploadArea').style.display = 'block';
  }

  document.getElementById('newsModal').classList.add('open');
  document.getElementById('fieldTitle').focus();
}

function removeImage() {
  pendingImageDataUri = '';
  document.getElementById('fieldImage').value = '';
  document.getElementById('imgPreviewWrap').style.display = 'none';
  document.getElementById('imgUploadArea').style.display = 'block';
}

function closeModal() {
  document.getElementById('newsModal').classList.remove('open');
}

document.addEventListener('DOMContentLoaded', () => {
  const fabAdd = document.getElementById('fabAdd');
  if (fabAdd) fabAdd.addEventListener('click', openAdd);

  const modalCloseBtn = document.querySelector('#newsModal .modal-close');
  if (modalCloseBtn) modalCloseBtn.addEventListener('click', closeModal);

  const modalCancelBtn = document.querySelector('#newsModal .btn-cancel');
  if (modalCancelBtn) modalCancelBtn.addEventListener('click', closeModal);

  const imgRemoveBtn = document.querySelector('.img-remove-btn');
  if (imgRemoveBtn) imgRemoveBtn.addEventListener('click', removeImage);

  document.getElementById('newsModal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeModal();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

  // Category filter chips.
  document.getElementById('newsFilters').addEventListener('click', e => {
    const chip = e.target.closest('button[data-filter]');
    if (!chip) return;
    activeFilter = chip.dataset.filter;
    renderFeed();
  });

  // Event delegation for dynamically rendered cards (reactions + admin controls).
  document.getElementById('newsFeed').addEventListener('click', e => {
    const btn = e.target.closest('button[data-react-id], button[data-edit-id], button[data-delete-id], button[data-more-id]');
    if (!btn) return;
    if (btn.dataset.reactId) {
      reactToNews(btn.dataset.reactId, btn.dataset.reactType);
    } else if (btn.dataset.editId) {
      openEdit(btn.dataset.editId);
    } else if (btn.dataset.deleteId) {
      deleteItem(btn.dataset.deleteId);
    } else if (btn.dataset.moreId) {
      toggleContent(btn);
    }
  });

  document.getElementById('fieldImage').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      pendingImageDataUri = await resizeImage(file, 900, 0.82);
      document.getElementById('imgPreview').src = pendingImageDataUri;
      document.getElementById('imgPreviewWrap').style.display = 'block';
      document.getElementById('imgUploadArea').style.display = 'none';
    } catch {
      document.getElementById('modalError').textContent = 'Impossible de charger l\'image.';
    }
  });

  document.getElementById('newsForm').addEventListener('submit', async e => {
    e.preventDefault();
    const id = document.getElementById('modalEditId').value;
    const payload = {
      title:        document.getElementById('fieldTitle').value.trim(),
      category:     document.getElementById('fieldCategory').value,
      content:      document.getElementById('fieldContent').value.trim(),
      url:          document.getElementById('fieldUrl').value.trim(),
      urlLabel:     document.getElementById('fieldUrlLabel').value.trim(),
      imageDataUri: pendingImageDataUri,
    };
    const errEl = document.getElementById('modalError');
    const btn = document.getElementById('modalSave');
    btn.disabled = true;
    btn.textContent = 'Enregistrement…';
    try {
      const token = localStorage.getItem('bwr_token');
      const res = await fetch(
        id ? `${API_URL}/api/news/${id}` : `${API_URL}/api/news`,
        {
          method: id ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(payload),
        }
      );
      const data = await res.json();
      if (!res.ok) { errEl.textContent = data.error || 'Erreur.'; return; }

      if (id) {
        allNews = allNews.map(n => n.id === id ? data : n);
      } else {
        allNews.unshift(data);
      }
      renderFeed();
      closeModal();
    } catch {
      errEl.textContent = 'Erreur réseau.';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Enregistrer';
    }
  });

  init();
});

async function deleteItem(id) {
  if (!confirm('Supprimer cet article ?')) return;
  try {
    const token = localStorage.getItem('bwr_token');
    const res = await fetch(`${API_URL}/api/news/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) { alert('Erreur lors de la suppression.'); return; }
    allNews = allNews.filter(n => n.id !== id);
    renderFeed();
  } catch {
    alert('Erreur réseau.');
  }
}

function resizeImage(file, maxPx, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = ev => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });
}

function attachFadeObserver() {
  const observer = new IntersectionObserver(entries => {
    entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('visible'); });
  }, { threshold: 0.08 });
  document.querySelectorAll('.news-card.fade-up:not(.visible)').forEach(el => observer.observe(el));
}
