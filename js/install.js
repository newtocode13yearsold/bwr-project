/* PWA install prompt — Android (beforeinstallprompt) + iOS manual guide */
(function () {
  // Don't show if already running as installed PWA
  if (window.matchMedia('(display-mode: standalone)').matches || navigator.standalone) return;

  // Don't show again for 7 days after dismissal
  const DISMISS_KEY = 'bwr_install_dismissed';
  const dismissed = localStorage.getItem(DISMISS_KEY);
  if (dismissed && Date.now() - Number(dismissed) < 7 * 24 * 3600 * 1000) return;

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;

  let deferredPrompt = null;

  function createBanner(isIOSGuide) {
    const banner = document.createElement('div');
    banner.id = 'pwa-install-banner';
    banner.setAttribute('role', 'banner');
    banner.setAttribute('aria-label', 'Installer l\'application');

    if (isIOSGuide) {
      banner.innerHTML = `
        <div class="pwa-banner-content">
          <img src="icons/icon.svg" class="pwa-banner-icon" alt="" aria-hidden="true" />
          <div class="pwa-banner-text">
            <strong>Installer BWR</strong>
            <span>Appuyez sur <span class="pwa-share-icon" aria-label="Partager">&#x2BAD;</span> puis <em>«&nbsp;Sur l'écran d'accueil&nbsp;»</em></span>
          </div>
          <button class="pwa-banner-dismiss" aria-label="Fermer">✕</button>
        </div>`;
    } else {
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
    }

    document.body.appendChild(banner);
    // Trigger slide-in animation on next frame
    requestAnimationFrame(() => banner.classList.add('pwa-banner-visible'));

    banner.querySelector('.pwa-banner-dismiss').addEventListener('click', dismiss);

    if (!isIOSGuide) {
      banner.querySelector('.pwa-banner-install').addEventListener('click', async () => {
        if (!deferredPrompt) return;
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        deferredPrompt = null;
        if (outcome === 'accepted') dismiss();
        else dismiss();
      });
    }
  }

  function dismiss() {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
    const banner = document.getElementById('pwa-install-banner');
    if (!banner) return;
    banner.classList.remove('pwa-banner-visible');
    banner.addEventListener('transitionend', () => banner.remove(), { once: true });
  }

  if (isIOS) {
    // Small delay so the page is visually settled before the banner appears
    setTimeout(() => createBanner(true), 2500);
    return;
  }

  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredPrompt = e;
    setTimeout(() => createBanner(false), 1500);
  });

  // Clean up if the app gets installed while the banner is visible
  window.addEventListener('appinstalled', dismiss);
}());
