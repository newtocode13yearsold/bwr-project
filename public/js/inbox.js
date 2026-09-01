/* In-app message inbox.
 * Everyone reads the messages addressed to them; ONLY the admin can send.
 * The admin also sees a compose form + a list of sent messages (with delete). */

let currentUser = null;

const root = () => document.getElementById('inboxRoot');

async function api(method, path, body) {
  const opts = { method, headers: { ...authHeader() } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${API_URL}${path}`, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Erreur');
  return data;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('fr-FR',
      { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

async function init() {
  currentUser = await requireAuth();
  if (!currentUser) return;
  if (currentUser.role === 'admin')
    document.querySelectorAll('.nav-drawer-admin').forEach(el => el.classList.remove('hidden'));
  await render();
}

async function render() {
  let data;
  try {
    data = await api('GET', '/api/inbox');
  } catch {
    root().innerHTML = '<div class="inbox-empty">Impossible de charger la messagerie.</div>';
    return;
  }

  let html = '';
  if (data.isAdmin) html += composeCard();

  const { messages } = data;
  html += `<div class="inbox-toolbar"><h2>Boîte de réception</h2>`;
  if (messages.some(m => !m.read))
    html += `<button class="btn-plain" id="btnReadAll">Tout marquer comme lu</button>`;
  html += `</div>`;

  if (!messages.length) {
    html += `<div class="inbox-empty">Aucun message pour l'instant.</div>`;
  } else {
    html += messages.map(msgCard).join('');
  }

  if (data.isAdmin) html += `<div id="sentWrap"></div>`;

  root().innerHTML = html;

  // Wire message cards: open/close + mark read on first open.
  root().querySelectorAll('.msg-card').forEach(card => {
    card.addEventListener('click', () => onMessageClick(card));
  });
  const readAll = document.getElementById('btnReadAll');
  if (readAll) readAll.addEventListener('click', onReadAll);

  if (data.isAdmin) {
    wireCompose();
    loadSent();
  }
}

function msgCard(m) {
  return `
    <div class="msg-card ${m.read ? '' : 'unread'}" data-id="${esc(m.id)}" data-read="${m.read ? '1' : '0'}">
      <div class="msg-head">
        <span class="msg-subject">
          ${m.read ? '' : '<span class="unread-dot" aria-label="Non lu"></span>'}
          ${esc(m.subject)}
          ${m.direct ? '<span class="msg-badge-direct">Personnel</span>' : ''}
        </span>
        <span class="msg-date">${fmtDate(m.createdAt)}</span>
      </div>
      <div class="msg-meta">De ${esc(m.senderName)}</div>
      <div class="msg-body">${esc(m.body)}</div>
    </div>`;
}

async function onMessageClick(card) {
  card.classList.toggle('open');
  if (card.dataset.read === '0' && card.classList.contains('open')) {
    card.dataset.read = '1';
    card.classList.remove('unread');
    const dot = card.querySelector('.unread-dot');
    if (dot) dot.remove();
    try { await api('POST', `/api/inbox/${encodeURIComponent(card.dataset.id)}/read`); } catch {}
    refreshToolbar();
  }
}

function refreshToolbar() {
  // Hide "tout marquer comme lu" once nothing is unread.
  if (!root().querySelector('.msg-card.unread')) {
    const btn = document.getElementById('btnReadAll');
    if (btn) btn.remove();
  }
}

async function onReadAll() {
  try { await api('POST', '/api/inbox/read-all'); } catch {}
  root().querySelectorAll('.msg-card').forEach(card => {
    card.dataset.read = '1';
    card.classList.remove('unread');
    const dot = card.querySelector('.unread-dot');
    if (dot) dot.remove();
  });
  const btn = document.getElementById('btnReadAll');
  if (btn) btn.remove();
}

// ── Admin compose ─────────────────────────────────────────────────────────────
function composeCard() {
  return `
    <div class="compose-card">
      <h2>Envoyer un message</h2>
      <p class="hint">Vous seul (administrateur) pouvez écrire aux membres.</p>
      <div class="form-group">
        <label class="form-label" for="composeTarget">Destinataire</label>
        <select class="form-select" id="composeTarget">
          <option value="all">📢 Tous les membres (diffusion)</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label" for="composeSubject">Sujet</label>
        <input type="text" class="form-input" id="composeSubject" maxlength="140" placeholder="Objet du message" />
      </div>
      <div class="form-group">
        <label class="form-label" for="composeBody">Message</label>
        <textarea class="form-textarea" id="composeBody" maxlength="5000" placeholder="Votre message…"></textarea>
      </div>
      <p class="compose-error" id="composeError"></p>
      <p class="compose-ok" id="composeOk"></p>
      <div class="compose-actions">
        <button class="btn-save" id="composeSend">Envoyer</button>
      </div>
    </div>`;
}

async function wireCompose() {
  // Populate the recipient dropdown from the admin user list.
  try {
    const users = await api('GET', '/api/users');
    const sel = document.getElementById('composeTarget');
    if (sel) {
      users
        .filter(u => u.role !== 'admin')
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
        .forEach(u => {
          const opt = document.createElement('option');
          opt.value = u.id;
          opt.textContent = `${u.name || 'Sans nom'} — ${u.email || ''}`;
          sel.appendChild(opt);
        });
    }
  } catch {}

  const btn = document.getElementById('composeSend');
  if (btn) btn.addEventListener('click', onSend);
}

async function onSend() {
  const target  = document.getElementById('composeTarget').value;
  const subject = document.getElementById('composeSubject').value.trim();
  const body    = document.getElementById('composeBody').value.trim();
  const errEl = document.getElementById('composeError');
  const okEl  = document.getElementById('composeOk');
  errEl.textContent = ''; okEl.textContent = '';

  if (!subject) { errEl.textContent = 'Le sujet ne peut pas être vide.'; return; }
  if (!body)    { errEl.textContent = 'Le message ne peut pas être vide.'; return; }

  const btn = document.getElementById('composeSend');
  btn.disabled = true;
  try {
    await api('POST', '/api/inbox', { target, subject, body });
    okEl.textContent = 'Message envoyé ✓';
    document.getElementById('composeSubject').value = '';
    document.getElementById('composeBody').value = '';
    loadSent();
  } catch (e) {
    errEl.textContent = e.message || 'Échec de l\'envoi.';
  } finally {
    btn.disabled = false;
  }
}

// ── Admin: sent messages list ───────────────────────────────────────────────
async function loadSent() {
  const wrap = document.getElementById('sentWrap');
  if (!wrap) return;
  let data;
  try { data = await api('GET', '/api/inbox/sent'); } catch { return; }
  const { sent } = data;
  if (!sent.length) { wrap.innerHTML = ''; return; }

  wrap.innerHTML = `<div class="sent-title">Messages envoyés</div>` + sent.map(m => {
    const to = m.target === 'all' ? 'Tous les membres' : (m.targetName || 'Membre');
    return `
      <div class="sent-row" data-id="${esc(m.id)}">
        <div class="sent-row-main">
          <div class="sent-row-subject">${esc(m.subject)}</div>
          <div class="sent-row-meta">À ${esc(to)} · ${fmtDate(m.createdAt)}</div>
        </div>
        <button class="sent-delete" data-id="${esc(m.id)}">Supprimer</button>
      </div>`;
  }).join('');

  wrap.querySelectorAll('.sent-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Supprimer ce message pour tous les destinataires ?')) return;
      try {
        await api('DELETE', `/api/inbox/${encodeURIComponent(btn.dataset.id)}`);
        render();
      } catch {}
    });
  });
}

document.addEventListener('DOMContentLoaded', init);
