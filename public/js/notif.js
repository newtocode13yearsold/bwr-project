// ── Notification bell — shows admin-set challenges/events ─────────────────────
(async function () {
  const wrap = document.getElementById('notifBell');
  if (!wrap) return;

  // Challenge is a public endpoint — no auth required
  let challenge = null;
  try {
    const res = await fetch(`${API_URL}/api/challenge`);
    if (res.ok) challenge = await res.json();
  } catch {}

  const setAt    = challenge?.setAt || '';
  const lastSeen = localStorage.getItem('bwr_notif_seen') || '';
  let   hasUnread = !!(challenge && setAt && setAt > lastSeen);

  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  wrap.innerHTML = `
    <button class="notif-bell-btn" id="notifBtn" aria-label="Notifications" title="Événements">
      <span class="notif-bell-icon">🔔</span>
      ${hasUnread ? '<span class="notif-dot"></span>' : ''}
    </button>
    <div class="notif-dropdown" id="notifDropdown" aria-live="polite">
      <div class="notif-hdr">Événements</div>
      ${challenge ? `
        <div class="notif-item">
          <span class="notif-item-icon">${challenge.icon || '🗓'}</span>
          <div class="notif-item-body">
            <strong class="notif-item-title">${esc(challenge.name)}</strong>
            <span class="notif-item-sub">Défi du mois · Objectif ${challenge.target} km</span>
            ${challenge.description ? `<p class="notif-item-desc">${esc(challenge.description)}</p>` : ''}
            <a class="notif-item-link" href="profile">Voir ma progression →</a>
          </div>
        </div>
      ` : '<p class="notif-empty">Aucun événement en cours.</p>'}
    </div>`;

  const btn      = document.getElementById('notifBtn');
  const dropdown = document.getElementById('notifDropdown');

  btn.addEventListener('click', e => {
    e.stopPropagation();
    const isOpen = dropdown.classList.contains('is-open');
    dropdown.classList.toggle('is-open', !isOpen);
    if (!isOpen && hasUnread) {
      hasUnread = false;
      localStorage.setItem('bwr_notif_seen', setAt);
      wrap.querySelector('.notif-dot')?.remove();
    }
  });

  document.addEventListener('click', () => dropdown.classList.remove('is-open'));
})();
