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

    // Le filtre de surface doit être présent dans le DOM
    const filterEl = page.locator('#surfaceFilter, [data-filter], .filter-btn').first();
    await expect(filterEl).toBeVisible({ timeout: 5_000 });
  });

  test('intercepte /api/reports et affiche les marqueurs', async ({ page }) => {
    await page.route('**/api/reports', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: 'r1',
          lat: 49.35,
          lng: 2.90,
          type: 'fallen_tree',
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

  test('le bouton Signaler est présent', async ({ page }) => {
    await mockAuthMe(page);
    await injectSession(page);
    await page.goto('/map.html');

    await expect(page.locator('.leaflet-container')).toBeVisible({ timeout: 10_000 });

    const btn = page.locator('button:has-text("Signaler"), #reportBtn, [id*="report"]').first();
    await expect(btn).toBeVisible({ timeout: 5_000 });
  });
});
