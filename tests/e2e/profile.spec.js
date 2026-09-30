// @ts-check
import { test, expect } from '@playwright/test';

async function mockAuthMe(page, plan = 'pro') {
  await page.route('**/api/auth/me', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      id: 'e2e-user-1',
      name: 'Testeur E2E',
      email: 'e2e@test.local',
      role: 'user',
      plan,
      stats: { routes: 12, km: 95 },
      badges: [],
    }),
  }));
}

async function injectSession(page, plan = 'pro') {
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

// ── Roue de la chance ─────────────────────────────────────────────────────────

test.describe('Roue de la chance (profile.html — Pro)', () => {

  test('affiche le canvas de la roue pour un utilisateur Pro', async ({ page }) => {
    await mockAuthMe(page, 'pro');
    await injectSession(page, 'pro');
    await page.goto('/profile.html#recompenses');

    await expect(page.locator('#premiumSection')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#wheelCanvas')).toBeVisible({ timeout: 5_000 });
  });

  test('le bouton Tourner la roue est activé si pas encore tourné aujourd\'hui', async ({ page }) => {
    await mockAuthMe(page, 'pro');
    await injectSession(page, 'pro');
    // Ensure no spin recorded today
    await page.goto('/profile.html#recompenses');
    await page.evaluate(() => localStorage.removeItem('bwr_wheel_last'));
    await page.goto('/profile.html#recompenses');

    await expect(page.locator('#wheelSpinBtn')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#wheelSpinBtn')).toBeEnabled({ timeout: 5_000 });
    await expect(page.locator('#wheelSpinBtn')).toContainText('Tourner la roue');
  });

  test('le bouton est désactivé si la roue a déjà été tournée aujourd\'hui', async ({ page }) => {
    await mockAuthMe(page, 'pro');
    await injectSession(page, 'pro');
    const today = new Date().toISOString().slice(0, 10);
    await page.goto('/profile.html#recompenses');
    await page.evaluate((today) => {
      localStorage.setItem('bwr_wheel_last', today);
      localStorage.setItem('bwr_wheel_result', JSON.stringify({
        icon: '🌲', label: 'Conseil sentier', desc: 'Profitez du sentier des Étangs.',
      }));
    }, today);
    await page.goto('/profile.html#recompenses');

    await expect(page.locator('#wheelSpinBtn')).toBeDisabled({ timeout: 10_000 });
    await expect(page.locator('#wheelSpinBtn')).toContainText('Tournée');
  });

  test('restaure le résultat du dernier tirage au rechargement', async ({ page }) => {
    await mockAuthMe(page, 'pro');
    await injectSession(page, 'pro');
    const today = new Date().toISOString().slice(0, 10);
    const prize = { icon: '🍀', label: 'Badge Chanceux', desc: 'Badge exclusif de la roue de la chance' };
    await page.goto('/profile.html#recompenses');
    await page.evaluate(({ today, prize }) => {
      localStorage.setItem('bwr_wheel_last', today);
      localStorage.setItem('bwr_wheel_result', JSON.stringify(prize));
    }, { today, prize });
    await page.goto('/profile.html#recompenses');

    const wheelText = page.locator('#wheelText');
    await expect(wheelText).toContainText('Badge Chanceux', { timeout: 10_000 });
  });

  test('déclenche un spin et affiche un résultat (Pro — sans appel réseau plan)', async ({ page }) => {
    // Stub any plan/wheel-prize API call to avoid network dependency
    await page.route('**/api/auth/wheel-prize', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, expiresAt: null }),
    }));
    await page.route('**/api/ai-tip', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ tip: 'Conseil sentier test.' }),
    }));

    await mockAuthMe(page, 'pro');
    await injectSession(page, 'pro');
    await page.goto('/profile.html#recompenses');
    await page.evaluate(() => localStorage.removeItem('bwr_wheel_last'));
    await page.goto('/profile.html#recompenses');

    const spinBtn = page.locator('#wheelSpinBtn');
    await expect(spinBtn).toBeEnabled({ timeout: 10_000 });
    await spinBtn.click();

    // After spin the button must be disabled and wheel text must be non-empty
    await expect(spinBtn).toBeDisabled({ timeout: 8_000 });
    const wheelText = page.locator('#wheelText');
    await expect(wheelText).not.toBeEmpty({ timeout: 8_000 });
    // The spin date must be persisted in localStorage
    const stored = await page.evaluate(() => localStorage.getItem('bwr_wheel_last'));
    const today = new Date().toISOString().slice(0, 10);
    expect(stored).toBe(today);
  });
});
