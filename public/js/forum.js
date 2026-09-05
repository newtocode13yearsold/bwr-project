/* Community forum — topic list + thread detail, with tier gating.
 * Free accounts can read the 5 most recent topics; Silver/Gold post & reply.
 * Single-page: the list and a topic detail are swapped into #forumRoot,
 * routed by the URL hash (#t/<topicId>). */

let currentUser = null;
let canPost = false;          // server's verdict for the current user (silver/gold/admin)
let editingTopicId = null;    // set while the modal is reused to edit an existing topic
let currentQuery = '';        // active forum search term (persists across list ↔ detail)
let searchToken = 0;          // guards against out-of-order search responses

const root = () => document.getElementById('forumRoot');

// ── Boot ──────────────────────────────────────────────────────────────────────
async function init() {
  try {
    const token = localStorage.getItem('bwr_token');
    if (token) {
      const res = await fetch(`${API_URL}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) currentUser = await res.json();
    }
  } catch {}

  updateNav();
  window.addEventListener('hashchange', route);
  route();
}

function updateNav() {
  if (currentUser?.role === 'admin')
    document.querySelectorAll('.nav-drawer-admin').forEach(el => el.classList.remove('hidden'));
}

function route() {
  const m = location.hash.match(/^#t\/(.+)$/);
  if (m) renderDetail(decodeURIComponent(m[1]));
  else renderList();
}

// ── List view ───────────────────────────────────────────────────────────────
// The toolbar + search box are rendered once; only #topicList is re-rendered on
// each search so the search input keeps its focus and caret between keystrokes.
async function renderList() {
  root().innerHTML = '<div class="forum-loading">Chargement du forum…</div>';
  let data;
  try {
    data = await fetchTopics(currentQuery);
  } catch {
    root().innerHTML = '<div class="forum-empty">Impossible de charger le forum.</div>';
    return;
  }
  canPost = !!data.canPost;

  const newBtn = canPost
    ? `<button class="btn-new" id="btnNewTopic">＋ Nouveau sujet</button>`
    : `<button class="btn-new" disabled title="Réservé aux membres Argent et Or">＋ Nouveau sujet</button>`;

  root().innerHTML = `
    <div class="forum-toolbar"><h2>Discussions</h2>${newBtn}</div>
    <div class="forum-search">
      <span class="forum-search-icon" aria-hidden="true">🔍</span>
      <input type="search" id="forumSearch" class="forum-search-input"
             placeholder="Rechercher un sujet…" autocomplete="off"
             value="${escAttr(currentQuery)}" />
    </div>
    <div id="topicList"></div>
  `;

  const btn = document.getElementById('btnNewTopic');
  if (btn) btn.addEventListener('click', openModal);

  const searchEl = document.getElementById('forumSearch');
  let debounce;
  searchEl.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => runSearch(searchEl.value), 250);
  });

  fillTopicList(data, currentQuery);
}

/** GET the topic list, appending ?q= when a search term is active. */
function fetchTopics(q) {
  const suffix = q ? `?q=${encodeURIComponent(q)}` : '';
  return api('GET', `/api/forum/topics${suffix}`);
}

/** Re-run the search and refresh only the list container (input untouched). */
async function runSearch(value) {
  currentQuery = value.trim();
  const listEl = document.getElementById('topicList');
  if (!listEl) return;
  const token = ++searchToken;
  listEl.innerHTML = '<div class="forum-loading">Recherche…</div>';
  try {
    const data = await fetchTopics(currentQuery);
    if (token !== searchToken) return;   // a newer keystroke already won
    canPost = !!data.canPost;
    fillTopicList(data, currentQuery);
  } catch {
    if (token === searchToken) listEl.innerHTML = '<div class="forum-empty">Erreur de recherche.</div>';
  }
}

/** Render topic cards (or an empty/no-results state) into #topicList. */
function fillTopicList(data, q) {
  const listEl = document.getElementById('topicList');
  if (!listEl) return;
  const { topics, lockedCount } = data;

  if (!topics.length) {
    if (q) {
      listEl.innerHTML = `<div class="forum-empty">Aucun sujet ne correspond à «&nbsp;${escHtml(q)}&nbsp;».</div>`;
    } else {
      listEl.innerHTML = emptyState(canPost);
      const emptyBtn = document.getElementById('btnNewTopicEmpty');
      if (emptyBtn) emptyBtn.addEventListener('click', openModal);
    }
    return;
  }

  let html = q
    ? `<div class="forum-results-count">${topics.length} résultat${topics.length > 1 ? 's' : ''} pour «&nbsp;${escHtml(q)}&nbsp;»</div>`
    : '';
  html += topics.map(topicCard).join('');
  if (lockedCount > 0) {
    html += `<div class="upsell-banner">
      <p>🔒 ${lockedCount} autre${lockedCount > 1 ? 's' : ''} sujet${lockedCount > 1 ? 's' : ''} ${lockedCount > 1 ? 'sont réservés' : 'est réservé'} aux membres Argent et Or.<br>
      Passe à un abonnement pour lire tout le forum et participer aux discussions.</p>
      <a href="plans">Voir les abonnements →</a>
    </div>`;
  }
  listEl.innerHTML = html;
}

function emptyState(canPost) {
  const illustration = `<svg class="empty-illu" viewBox="0 0 120 96" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <ellipse cx="60" cy="86" rx="44" ry="6" fill="var(--forest-600,#2d6b1f)" opacity="0.10"/>
    <!-- back trees -->
    <path d="M26 74V60l-9 2 9-14-7 1 11-16 11 16-7-1 9 14-9-2v14z" fill="var(--forest-600,#2d6b1f)" opacity="0.28"/>
    <path d="M94 74V60l-9 2 9-14-7 1 11-16 11 16-7-1 9 14-9-2v14z" fill="var(--forest-600,#2d6b1f)" opacity="0.28"/>
    <!-- speech bubble -->
    <rect x="34" y="20" width="52" height="38" rx="12" fill="var(--forest-600,#2d6b1f)" opacity="0.14"/>
    <rect x="34" y="20" width="52" height="38" rx="12" stroke="var(--forest-600,#2d6b1f)" stroke-width="2.5" opacity="0.55"/>
    <path d="M50 58l-2 10 12-10z" fill="var(--forest-600,#2d6b1f)" opacity="0.14" stroke="var(--forest-600,#2d6b1f)" stroke-width="2.5"/>
    <circle cx="48" cy="39" r="3.2" fill="var(--forest-600,#2d6b1f)"/>
    <circle cx="60" cy="39" r="3.2" fill="var(--forest-600,#2d6b1f)"/>
    <circle cx="72" cy="39" r="3.2" fill="var(--forest-600,#2d6b1f)"/>
  </svg>`;
  if (canPost) {
    return `<div class="forum-empty-state">
      ${illustration}
      <h3>Aucune discussion pour l'instant</h3>
      <p>Soyez le premier à lancer une discussion : posez une question, partagez un sentier ou racontez une balade.</p>
      <button class="btn-new" id="btnNewTopicEmpty">＋ Lancer la première discussion</button>
    </div>`;
  }
  return `<div class="forum-empty-state">
    ${illustration}
    <h3>Aucune discussion pour l'instant</h3>
    <p>Le forum se remplit bientôt. Passez à un abonnement Argent ou Or pour lancer la première discussion.</p>
    <a class="btn-new" href="plans">Voir les abonnements →</a>
  </div>`;
}

function topicCard(t) {
  if (t.locked) {
    return `<div class="topic-card locked">
      <div class="topic-card-title">🔒 ${escHtml(t.title)}</div>
      <a class="lock-pill" href="plans">🥈 Débloquer avec Argent</a>
    </div>`;
  }
  const replies = t.replyCount || 0;
  return `<div class="topic-card" data-id="${escAttr(t.id)}">
    <div class="topic-card-title">${escHtml(t.title)}</div>
    ${t.preview ? `<div class="topic-card-preview">${escHtml(t.preview)}</div>` : ''}
    <div class="topic-card-meta">
      <span class="topic-card-author">${escHtml(t.authorName || 'Membre')}</span>
      <span>${relTime(t.lastActivityAt || t.createdAt)}</span>
      <span class="topic-card-replies">💬 ${replies} réponse${replies > 1 ? 's' : ''}</span>
    </div>
  </div>`;
}

// ── Detail view ───────────────────────────────────────────────────────────────
async function renderDetail(id) {
  root().innerHTML = '<div class="forum-loading">Chargement du sujet…</div>';
  let data;
  try {
    data = await api('GET', `/api/forum/topics/${encodeURIComponent(id)}`);
  } catch (err) {
    const locked = err.status === 403;
    root().innerHTML = `<button class="detail-back">← Retour</button>
      <div class="forum-empty">${locked
        ? '🔒 Ce sujet est réservé aux membres Argent et Or.<br><br><a class="lock-pill" href="plans">Voir les abonnements →</a>'
        : 'Sujet introuvable.'}</div>`;
    return;
  }

  const { topic, replies, canModerate, currentUserId } = data;
  canPost = !!data.canPost;

  const op = postBlock(topic.authorName, topic.body, topic.createdAt, true,
    canDelete(topic.userId, currentUserId, canModerate) ? `topic:${topic.id}` : null, topic.editedAt);

  const replyBlocks = replies.map(rep =>
    postBlock(rep.authorName, rep.body, rep.createdAt, false,
      canDelete(rep.userId, currentUserId, canModerate) ? `reply:${rep.id}` : null, rep.editedAt)
  ).join('');

  const composer = canPost
    ? `<div class="composer">
         <textarea id="replyBody" placeholder="Écrivez votre réponse…" maxlength="4000"></textarea>
         <div class="composer-error" id="replyError"></div>
         <div class="composer-actions"><button class="btn-save" id="btnReply">Répondre</button></div>
       </div>`
    : `<div class="composer"><div class="composer-locked">
         Réponse réservée aux membres Argent et Or. <a href="plans">Voir les abonnements →</a>
       </div></div>`;

  root().innerHTML = `
    <button class="detail-back">← Tous les sujets</button>
    <div class="detail-head"><h1 class="detail-title">${escHtml(topic.title)}</h1></div>
    ${op}
    <div class="replies-title">${replies.length} réponse${replies.length > 1 ? 's' : ''}</div>
    <div id="replyList">${replyBlocks}</div>
    ${composer}
  `;

  const btnReply = document.getElementById('btnReply');
  if (btnReply) btnReply.addEventListener('click', () => submitReply(topic.id));

  root().querySelectorAll('[data-del]').forEach(el =>
    el.addEventListener('click', () => onDelete(topic.id, el.dataset.del))
  );
  root().querySelectorAll('[data-edit]').forEach(el =>
    el.addEventListener('click', () => onEdit(topic, replies, el.dataset.edit, el.closest('.post')))
  );
}

function postBlock(name, body, date, isOp, delRef, editedAt) {
  const initial = (name || 'M').trim().charAt(0).toUpperCase();
  // Author/admin can edit or delete — both gated by the same `delRef`.
  const editBtn = delRef ? `<button class="post-edit" data-edit="${escAttr(delRef)}">Modifier</button>` : '';
  const delBtn  = delRef ? `<button class="post-delete" data-del="${escAttr(delRef)}">Supprimer</button>` : '';
  const actions = delRef ? `<div class="post-actions">${editBtn}${delBtn}</div>` : '';
  return `<div class="post${isOp ? ' op' : ''}"${delRef ? ` data-post="${escAttr(delRef)}"` : ''}>
    <div class="post-head">
      <div class="post-author">
        <div class="post-avatar">${escHtml(initial)}</div>
        <div>
          <div class="post-author-name">${escHtml(name || 'Membre')}</div>
          <div class="post-date">${relTime(date)}${editedAt ? ' · modifié' : ''}</div>
        </div>
      </div>
      ${actions}
    </div>
    <div class="post-body">${escHtml(body)}</div>
  </div>`;
}

function canDelete(authorId, currentUserId, canModerate) {
  return canModerate || (currentUserId && authorId === currentUserId);
}

// ── Actions ───────────────────────────────────────────────────────────────────
async function submitReply(topicId) {
  const ta = document.getElementById('replyBody');
  const errEl = document.getElementById('replyError');
  const btn = document.getElementById('btnReply');
  const body = ta.value.trim();
  errEl.textContent = '';
  if (!body) { errEl.textContent = 'La réponse ne peut pas être vide.'; return; }

  btn.disabled = true; btn.textContent = 'Envoi…';
  try {
    await api('POST', `/api/forum/topics/${encodeURIComponent(topicId)}/replies`, { body });
    renderDetail(topicId);
  } catch (err) {
    errEl.textContent = err.message || 'Erreur lors de l\'envoi.';
    btn.disabled = false; btn.textContent = 'Répondre';
  }
}

async function onDelete(topicId, ref) {
  const [kind, id] = ref.split(':');
  if (kind === 'topic') {
    if (!confirm('Supprimer ce sujet et toutes ses réponses ?')) return;
    try {
      await api('DELETE', `/api/forum/topics/${encodeURIComponent(id)}`);
      location.hash = '';
    } catch (err) { alert(err.message || 'Erreur.'); }
  } else {
    if (!confirm('Supprimer cette réponse ?')) return;
    try {
      await api('DELETE', `/api/forum/topics/${encodeURIComponent(topicId)}/replies/${encodeURIComponent(id)}`);
      renderDetail(topicId);
    } catch (err) { alert(err.message || 'Erreur.'); }
  }
}

// ── Edit ────────────────────────────────────────────────────────────────────
function onEdit(topic, replies, ref, postEl) {
  const [kind, id] = ref.split(':');
  if (kind === 'topic') {
    openModalForEdit(topic);
  } else {
    const reply = replies.find(rp => rp.id === id);
    if (reply && postEl) startReplyEdit(topic.id, reply, postEl);
  }
}

/** Swap a reply's body for an inline editor (Enregistrer / Annuler). */
function startReplyEdit(topicId, reply, postEl) {
  const bodyEl = postEl.querySelector('.post-body');
  bodyEl.innerHTML = `
    <textarea class="edit-textarea" maxlength="4000"></textarea>
    <div class="composer-error edit-error"></div>
    <div class="edit-actions">
      <button type="button" class="btn-cancel edit-cancel">Annuler</button>
      <button type="button" class="btn-save edit-save">Enregistrer</button>
    </div>`;
  const ta = bodyEl.querySelector('.edit-textarea');
  ta.value = reply.body;               // set via value so raw text isn't parsed as HTML
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);

  const errEl = bodyEl.querySelector('.edit-error');
  bodyEl.querySelector('.edit-cancel').addEventListener('click', () => renderDetail(topicId));
  bodyEl.querySelector('.edit-save').addEventListener('click', async () => {
    const body = ta.value.trim();
    errEl.textContent = '';
    if (!body) { errEl.textContent = 'La réponse ne peut pas être vide.'; return; }
    const saveBtn = bodyEl.querySelector('.edit-save');
    saveBtn.disabled = true; saveBtn.textContent = 'Enregistrement…';
    try {
      await api('PUT', `/api/forum/topics/${encodeURIComponent(topicId)}/replies/${encodeURIComponent(reply.id)}`, { body });
      renderDetail(topicId);
    } catch (err) {
      errEl.textContent = err.message || 'Erreur.';
      saveBtn.disabled = false; saveBtn.textContent = 'Enregistrer';
    }
  });
}

// ── New-topic modal (also reused to edit an existing topic) ────────────────────
function openModal() {
  editingTopicId = null;
  document.getElementById('modalTitle').textContent = 'Nouveau sujet';
  document.getElementById('modalSave').textContent = 'Publier';
  document.getElementById('fieldTitle').value = '';
  document.getElementById('fieldBody').value = '';
  document.getElementById('modalError').textContent = '';
  document.getElementById('topicModal').classList.add('open');
  document.getElementById('fieldTitle').focus();
}
function openModalForEdit(topic) {
  editingTopicId = topic.id;
  document.getElementById('modalTitle').textContent = 'Modifier le sujet';
  document.getElementById('modalSave').textContent = 'Enregistrer';
  document.getElementById('fieldTitle').value = topic.title || '';
  document.getElementById('fieldBody').value = topic.body || '';
  document.getElementById('modalError').textContent = '';
  document.getElementById('topicModal').classList.add('open');
  document.getElementById('fieldTitle').focus();
}
function closeModal() { editingTopicId = null; document.getElementById('topicModal').classList.remove('open'); }

// ── Helpers ───────────────────────────────────────────────────────────────────
/** fetch wrapper: attaches the Bearer token, parses JSON, throws {status,message} on error. */
async function api(method, path, body) {
  const token = localStorage.getItem('bwr_token');
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) { const e = new Error(data?.error || 'Erreur'); e.status = res.status; throw e; }
  return data;
}

function relTime(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const m = Math.round(diff / 60000), h = Math.round(diff / 3600000), d = Math.round(diff / 86400000);
  if (diff < 60000) return 'à l\'instant';
  if (m < 60) return `il y a ${m} min`;
  if (h < 24) return `il y a ${h} h`;
  if (d < 7) return `il y a ${d} j`;
  return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escAttr(str) { return escHtml(str).replace(/'/g, '&#39;'); }

// ── Wiring ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('modalClose').addEventListener('click', closeModal);
  document.getElementById('modalCancel').addEventListener('click', closeModal);
  document.getElementById('topicModal').addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

  // Content is rendered dynamically — delegate clicks from the root.
  // (Inline onclick handlers are blocked by the page CSP, so wire them here.)
  root().addEventListener('click', e => {
    if (e.target.closest('.detail-back')) { location.hash = ''; return; }
    const card = e.target.closest('.topic-card[data-id]');
    if (card) location.hash = `#t/${encodeURIComponent(card.dataset.id)}`;
  });

  document.getElementById('topicForm').addEventListener('submit', async e => {
    e.preventDefault();
    const title = document.getElementById('fieldTitle').value.trim();
    const body  = document.getElementById('fieldBody').value.trim();
    const errEl = document.getElementById('modalError');
    const btn   = document.getElementById('modalSave');
    errEl.textContent = '';
    if (title.length < 3) { errEl.textContent = 'Le titre doit faire au moins 3 caractères.'; return; }
    if (!body)            { errEl.textContent = 'Le message ne peut pas être vide.'; return; }

    const editId = editingTopicId;
    btn.disabled = true; btn.textContent = editId ? 'Enregistrement…' : 'Publication…';
    try {
      if (editId) {
        await api('PUT', `/api/forum/topics/${encodeURIComponent(editId)}`, { title, body });
        closeModal();
        renderDetail(editId);
      } else {
        const topic = await api('POST', '/api/forum/topics', { title, body });
        closeModal();
        location.hash = `#t/${encodeURIComponent(topic.id)}`;
      }
    } catch (err) {
      errEl.textContent = err.message || 'Erreur.';
    } finally {
      btn.disabled = false; btn.textContent = editId ? 'Enregistrer' : 'Publier';
    }
  });

  init();
});
