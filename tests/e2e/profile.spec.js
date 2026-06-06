// @ts-check
import { test, expect } from '@playwright/test';

async function mockAuthMe(page, plan = 'silver') {
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

async function injectSession(page, plan = 'silver') {
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

test.describe('Roue de la chance (profile.html — Silver)', () => {

  test('affiche le canvas de la roue pour un utilisateur Silver', async ({ page }) => {
    await mockAuthMe(page, 'silver');
    await injectSession(page, 'silver');
    await page.goto('/profile.html');

    await expect(page.locator('#premiumSection')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#wheelCanvas')).toBeVisible({ timeout: 5_000 });
  });

  test('le bouton Tourner la roue est activé si pas encore tourné aujourd\'hui', async ({ page }) => {
    await mockAuthMe(page, 'silver');
    await injectSession(page, 'silver');
    // Ensure no spin recorded today
    await page.goto('/profile.html');
    await page.evaluate(() => localStorage.removeItem('bwr_wheel_last'));
    await page.goto('/profile.html');

    await expect(page.locator('#wheelSpinBtn')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#wheelSpinBtn')).toBeEnabled({ timeout: 5_000 });
    await expect(page.locator('#wheelSpinBtn')).toContainText('Tourner la roue');
  });

  test('le bouton est désactivé si la roue a déjà été tournée aujourd\'hui', async ({ page }) => {
    await mockAuthMe(page, 'silver');
    await injectSession(page, 'silver');
    const today = new Date().toISOString().slice(0, 10);
    await page.goto('/profile.html');
    await page.evaluate((today) => {
      localStorage.setItem('bwr_wheel_last', today);
      localStorage.setItem('bwr_wheel_result', JSON.stringify({
        icon: '🌲', label: 'Conseil sentier', desc: 'Profitez du sentier des Étangs.',
      }));
    }, today);
    await page.goto('/profile.html');

    await expect(page.locator('#wheelSpinBtn')).toBeDisabled({ timeout: 10_000 });
    await expect(page.locator('#wheelSpinBtn')).toContainText('Tournée');
  });

  test('restaure le résultat du dernier tirage au rechargement', async ({ page }) => {
    await mockAuthMe(page, 'silver');
    await injectSession(page, 'silver');
    const today = new Date().toISOString().slice(0, 10);
    const prize = { icon: '🍀', label: 'Badge Chanceux', desc: 'Badge exclusif de la roue de la chance' };
    await page.goto('/profile.html');
    await page.evaluate(({ today, prize }) => {
      localStorage.setItem('bwr_wheel_last', today);
      localStorage.setItem('bwr_wheel_result', JSON.stringify(prize));
    }, { today, prize });
    await page.goto('/profile.html');

    const wheelText = page.locator('#wheelText');
    await expect(wheelText).toContainText('Badge Chanceux', { timeout: 10_000 });
  });

  test('déclenche un spin et affiche un résultat (Silver — sans appel réseau plan)', async ({ page }) => {
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

    await mockAuthMe(page, 'silver');
    await injectSession(page, 'silver');
    await page.goto('/profile.html');
    await page.evaluate(() => localStorage.removeItem('bwr_wheel_last'));
    await page.goto('/profile.html');

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

// ── Météo (Gold uniquement) ───────────────────────────────────────────────────

test.describe('Widget météo (profile.html — Gold)', () => {

  const MOCK_WEATHER = {
    current: {
      temperature_2m: 18,
      apparent_temperature: 16,
      weather_code: 1,
      wind_speed_10m: 12,
      relative_humidity_2m: 65,
      precipitation_probability: 10,
    },
    daily: {
      time: ['2026-05-30', '2026-05-31', '2026-06-01', '2026-06-02'],
      weather_code: [1, 2, 3, 61],
      temperature_2m_max: [20, 22, 19, 15],
      temperature_2m_min: [12, 13, 11, 10],
      precipitation_probability_max: [5, 15, 30, 80],
    },
  };

  test('weatherBlock est visible pour Gold', async ({ page }) => {
    await page.route('**open-meteo.com/**', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_WEATHER),
    }));
    await mockAuthMe(page, 'gold');
    await injectSession(page, 'gold');
    await page.goto('/profile.html');

    await expect(page.locator('#weatherBlock')).toBeVisible({ timeout: 10_000 });
  });

  test('affiche la température et l\'icône météo', async ({ page }) => {
    await page.route('**open-meteo.com/**', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_WEATHER),
    }));
    await mockAuthMe(page, 'gold');
    await injectSession(page, 'gold');
    await page.goto('/profile.html');

    await expect(page.locator('#weatherTemp')).toContainText('18', { timeout: 10_000 });
    await expect(page.locator('#weatherIcon')).not.toBeEmpty({ timeout: 5_000 });
    await expect(page.locator('#weatherIcon')).not.toContainText('⏳');
  });

  test('affiche les détails météo (vent, humidité, précipitations)', async ({ page }) => {
    await page.route('**open-meteo.com/**', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_WEATHER),
    }));
    await mockAuthMe(page, 'gold');
    await injectSession(page, 'gold');
    await page.goto('/profile.html');

    await expect(page.locator('#weatherDetails')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#wdWind')).toContainText('km/h');
    await expect(page.locator('#wdHumidity')).toContainText('%');
    await expect(page.locator('#wdPrecip')).toContainText('%');
  });

  test('affiche le bandeau prévisions 4 jours', async ({ page }) => {
    await page.route('**open-meteo.com/**', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_WEATHER),
    }));
    await mockAuthMe(page, 'gold');
    await injectSession(page, 'gold');
    await page.goto('/profile.html');

    const forecast = page.locator('#weatherForecast .weather-day');
    await expect(forecast).toHaveCount(4, { timeout: 10_000 });
  });

  test('affiche une erreur si l\'API météo échoue', async ({ page }) => {
    await page.route('**open-meteo.com/**', route => route.abort());
    await mockAuthMe(page, 'gold');
    await injectSession(page, 'gold');
    await page.goto('/profile.html');

    await expect(page.locator('#weatherBlock')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#weatherIcon')).toContainText('❌', { timeout: 8_000 });
  });

  test('weatherBlock est caché pour Silver', async ({ page }) => {
    await mockAuthMe(page, 'silver');
    await injectSession(page, 'silver');
    await page.goto('/profile.html');

    await expect(page.locator('#premiumSection')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#weatherBlock')).toBeHidden({ timeout: 5_000 });
  });
});
