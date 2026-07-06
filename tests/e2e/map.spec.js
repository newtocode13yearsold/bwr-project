// @ts-check
import { test, expect } from '@playwright/test';

// Injecte une session valide avant chaque test
async function injectSession(page, plan = 'free') {
  await page.goto('/login.html');
  await page.evaluate((plan) => {
    localStorage.setItem('bwr_token', 'e2e-mock-token');
    localStorage.setItem('bwr_user', JSON.stringify({
      id: 'e2e-user-1',
      name: 'Testeur E2E',
      email: 'e2e@test.local',
      role: 'user',
      plan,
    }));
    // Marque le tutoriel d'accueil comme déjà vu : sur un navigateur neuf
    // (toujours le cas en CI) l'overlay « Bienvenue sur BWR » s'affiche sinon
    // au-dessus de la carte et intercepte les clics (#toggleFilters, etc.).
    localStorage.setItem('bwr_tutorial_seen', '1');
  }, plan);
}

// Intercepte /api/auth/me pour renvoyer un user valide sans vrai token
async function mockAuthMe(page, plan = 'free') {
  await page.route('**/api/auth/me', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      id: 'e2e-user-1',
      name: 'Testeur E2E',
      email: 'e2e@test.local',
      role: 'user',
      plan,
      stats: { routes: 3, km: 42 },
      badges: [],
    }),
  }));
}

test.describe('Carte (map.html)', () => {

  test('charge la carte Leaflet', async ({ page }) => {
    await mockAuthMe(page);
    await injectSession(page);
    await page.goto('/map.html');

    // La div #map doit exister et Leaflet doit s'être initialisé
    await expect(page.locator('#map')).toBeVisible({ timeout: 10_000 });
    // Leaflet ajoute .leaflet-container sur la div
    await expect(page.locator('.leaflet-container')).toBeVisible({ timeout: 10_000 });
  });

  test('affiche le header avec navigation', async ({ page }) => {
    await mockAuthMe(page);
    await injectSession(page);
    await page.goto('/map.html');

    await expect(page.locator('header.header')).toBeVisible();
  });

  test('le panneau de filtres est accessible', async ({ page }) => {
    await mockAuthMe(page);
    await injectSession(page);
    await page.goto('/map.html');

    await expect(page.locator('.leaflet-container')).toBeVisible({ timeout: 10_000 });

    // Le panneau est caché par défaut — ouvrir via le bouton toggle
    await page.click('#toggleFilters');
    // Les cases à cocher de filtre doivent être visibles dans le panneau ouvert
    await expect(page.locator('#filterPanel .filter-check').first()).toBeVisible({ timeout: 5_000 });
  });

  test('intercepte /api/reports et affiche les marqueurs', async ({ page }) => {
    await page.route('**/api/reports', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: 'r1',
          lat: 49.35,
          lon: 2.90,
          type: 'fallen_tree',
          status: 'open',
          description: 'Arbre tombé',
          createdAt: new Date().toISOString(),
        },
      ]),
    }));
    await mockAuthMe(page);
    await injectSession(page);
    await page.goto('/map.html');

    await expect(page.locator('.leaflet-container')).toBeVisible({ timeout: 10_000 });
    // Au moins un marqueur Leaflet doit être rendu
    await expect(page.locator('.leaflet-marker-icon').first()).toBeVisible({ timeout: 8_000 });
  });
});

test.describe('Signalement de problème', () => {

  test('le bouton Contact (signalement) est présent', async ({ page }) => {
    await mockAuthMe(page);
    await injectSession(page);
    await page.goto('/map.html');

    await expect(page.locator('.leaflet-container')).toBeVisible({ timeout: 10_000 });

    // Le bouton Signaler apparaît dans les popups de chemin (clic sur un tracé).
    // On vérifie ici que le bouton Contact (#btnOpenContact) est accessible,
    // et que le panneau de filtre contient les cases "not_passable" / "no_bike"
    // — preuve que l'UI de signalement est présente.
    await expect(page.locator('#btnOpenContact')).toBeVisible({ timeout: 5_000 });
    await page.click('#toggleFilters');
    await expect(page.locator('#filterPanel input[value="not_passable"]')).toBeAttached();
  });
});
