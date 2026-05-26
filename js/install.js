/* PWA install prompt — Android (beforeinstallprompt) + iOS manual guide */
(function () {
  const DISMISS_KEY = 'bwr_install_dismissed';
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  const isIOSSafari = isIOS && !/CriOS|FxiOS|OPiOS|EdgiOS/i.test(navigator.userAgent);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;

  let deferredPrompt = null;

  // ── Button wiring ─────────────────────────────────────────────────────────
  function getBtn() { return document.getElementById('btnInstallApp'); }

  function showInstallBtn() {
    const btn = getBtn();
    if (btn) btn.style.display = '';
  }

  function hideInstallBtn() {
    const btn = getBtn();
    if (btn) btn.style.display = 'none';
  }

  // ── iOS guide modal ───────────────────────────────────────────────────────
  function showIOSBanner() {
    if (document.getElementById('pwa-ios-modal')) return;
    const modal = document.createElement('div');
    modal.id = 'pwa-ios-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Installer BWR');
    modal.innerHTML = `
      <div class="pwa-ios-sheet">
        <div class="pwa-ios-header">
          <img src="icons/icon.svg" class="pwa-ios-appicon" alt="" aria-hidden="true" />
          <div>
            <strong>Installer BWR</strong>
            <span>Accès rapide depuis votre écran d'accueil</span>
          </div>
          <button class="pwa-ios-close" aria-label="Fermer">✕</button>
        </div>
        ${isIOSSafari ? `
        <ol class="pwa-ios-steps">
          <li>
            <span class="pwa-ios-step-num">1</span>
            <span>Appuyez sur le bouton <strong>Partager</strong> en bas de Safari&nbsp;
              <svg class="pwa-ios-share-svg" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path d="M12 16V4M12 4L7 9M12 4L17 9" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M4 14V19C4 19.5523 4.44772 20 5 20H19C19.5523 20 20 19.5523 20 19V14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
              </svg>
            </span>
          </li>
          <li>
            <span class="pwa-ios-step-num">2</span>
            <span>Faites défiler et appuyez sur <strong>« Sur l'écran d'accueil »</strong></span>
          </li>
          <li>
            <span class="pwa-ios-step-num">3</span>
            <span>Appuyez sur <strong>Ajouter</strong> en haut à droite</span>
          </li>
        </ol>` : `
        <ol class="pwa-ios-steps">
          <li>
            <span class="pwa-ios-step-num">1</span>
            <span>Appuyez sur les <strong>3 points</strong> en bas à droite de Chrome</span>
          </li>
          <li>
            <span class="pwa-ios-step-num">2</span>
            <span>Appuyez sur <strong>« Ajouter à l'écran d'accueil »</strong></span>
          </li>
          <li>
            <span class="pwa-ios-step-num">3</span>
            <span>Appuyez sur <strong>Ajouter</strong></span>
          </li>
        </ol>`}
      </div>
      <div class="pwa-ios-backdrop"></div>`;
    document.body.appendChild(modal);
    requestAnimationFrame(() => modal.classList.add('pwa-ios-visible'));
    modal.querySelector('.pwa-ios-close').addEventListener('click', dismissBanner);
    modal.querySelector('.pwa-ios-backdrop').addEventListener('click', dismissBanner);
  }

  function dismissBanner() {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
    const modal = document.getElementById('pwa-ios-modal');
    if (modal) {
      modal.classList.remove('pwa-ios-visible');
      modal.addEventListener('transitionend', () => modal.remove(), { once: true });
    }
    const banner = document.getElementById('pwa-install-banner');
    if (banner) {
      banner.classList.remove('pwa-banner-visible');
      banner.addEventListener('transitionend', () => banner.remove(), { once: true });
    }
  }

  // ── Public trigger (called by the header button) ──────────────────────────
  async function trigger() {
    if (isIOS) {
      showIOSBanner();
      return;
    }
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      deferredPrompt = null;
      if (outcome === 'accepted') hideInstallBtn();
    }
  }

  window.BWRInstall = { trigger };

  // Wire button click as soon as DOM is ready
  document.addEventListener('DOMContentLoaded', () => {
    const btn = getBtn();
    if (btn) btn.addEventListener('click', trigger);
  });

  // Already installed — hide the button, nothing to do
  if (isStandalone) { hideInstallBtn(); return; }

  if (isIOS) {
    // Show button on iOS so the user can tap for the manual guide
    document.addEventListener('DOMContentLoaded', showInstallBtn);

    // Also auto-show the banner after a delay unless recently dismissed
    const dismissed = localStorage.getItem(DISMISS_KEY);
    if (!dismissed || Date.now() - Number(dismissed) >= 7 * 24 * 3600 * 1000) {
      setTimeout(showIOSBanner, 2500);
    }
    return;
  }

  // Android / desktop — show button only when browser signals it's installable
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredPrompt = e;
    showInstallBtn();

    // Also auto-show banner after short delay unless recently dismissed
    const dismissed = localStorage.getItem(DISMISS_KEY);
    if (!dismissed || Date.now() - Number(dismissed) >= 7 * 24 * 3600 * 1000) {
      setTimeout(() => {
        if (!document.getElementById('pwa-install-banner')) {
          const banner = document.createElement('div');
          banner.id = 'pwa-install-banner';
          banner.setAttribute('role', 'banner');
          banner.setAttribute('aria-label', 'Installer l\'application');
          banner.innerHTML = `
            <div class="pwa-banner-content">
              <img src="icons/icon.svg" class="pwa-banner-icon" alt="" aria-hidden="true" />
              <div class="pwa-banner-text">
                <strong>Installer BWR</strong>
                <span>Accès rapide, fonctionne hors-ligne</span>
              </div>
              <button class="pwa-banner-install" aria-label="Installer l'application">Installer</button>
              <button class="pwa-banner-dismiss" aria-label="Fermer">✕</button>
            </div>`;
          document.body.appendChild(banner);
          requestAnimationFrame(() => banner.classList.add('pwa-banner-visible'));
          banner.querySelector('.pwa-banner-dismiss').addEventListener('click', dismissBanner);
          banner.querySelector('.pwa-banner-install').addEventListener('click', trigger);
        }
      }, 1500);
    }
  });

  window.addEventListener('appinstalled', hideInstallBtn);
}());
