let currentUser = null;
let allNews = [];

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
    loginLink.href = 'profile.html';
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

function renderFeed() {
  const feed = document.getElementById('newsFeed');
  if (!allNews.length) {
    feed.innerHTML = '<div class="news-empty">Aucune actualité pour l\'instant.</div>';
    return;
  }
  feed.innerHTML = allNews.map(item => newsCard(item)).join('');
  attachFadeObserver();
}

function newsCard(item) {
  const date = new Date(item.createdAt).toLocaleDateString('fr-FR', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
  const plan = currentUser?.role === 'admin' ? 'gold' : (currentUser?.plan || 'free');
  const canLink = plan === 'silver' || plan === 'gold';
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
         <button class="news-btn-edit" onclick="openEdit('${item.id}')">Modifier</button>
         <button class="news-btn-delete" onclick="deleteItem('${item.id}')">Supprimer</button>
       </div>`
    : '';
  return `
    <article class="news-card fade-up" data-id="${item.id}">
      <div class="news-meta">
        <span class="news-date">${date}</span>
      </div>
      <h2 class="news-title">${escHtml(item.title)}</h2>
      ${item.content ? `<p class="news-content">${escHtml(item.content).replace(/\n/g, '<br>')}</p>` : ''}
      ${linkHtml}
      ${adminControls}
    </article>`;
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
  document.getElementById('fieldContent').value = item?.content || '';
  document.getElementById('fieldUrl').value = item?.url || '';
  document.getElementById('fieldUrlLabel').value = item?.urlLabel || '';
  document.getElementById('modalEditId').value = item?.id || '';
  document.getElementById('modalError').textContent = '';
  document.getElementById('newsModal').classList.add('open');
  document.getElementById('fieldTitle').focus();
}

function closeModal() {
  document.getElementById('newsModal').classList.remove('open');
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('newsModal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeModal();
  });

  document.getElementById('newsForm').addEventListener('submit', async e => {
    e.preventDefault();
    const id = document.getElementById('modalEditId').value;
    const payload = {
      title:    document.getElementById('fieldTitle').value.trim(),
      content:  document.getElementById('fieldContent').value.trim(),
      url:      document.getElementById('fieldUrl').value.trim(),
      urlLabel: document.getElementById('fieldUrlLabel').value.trim(),
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

  // Sticky nav
  const nav = document.getElementById('nav');
  window.addEventListener('scroll', () => {
    nav.classList.toggle('scrolled', window.scrollY > 20);
  });

  // Mobile burger
  document.getElementById('navBurger').addEventListener('click', () => {
    document.getElementById('navMobile').classList.toggle('hidden');
  });
  document.querySelectorAll('.nav-mobile a').forEach(a => {
    a.addEventListener('click', () =>
      document.getElementById('navMobile').classList.add('hidden'));
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

function attachFadeObserver() {
  const observer = new IntersectionObserver(entries => {
    entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('visible'); });
  }, { threshold: 0.08 });
  document.querySelectorAll('.news-card.fade-up:not(.visible)').forEach(el => observer.observe(el));
}
