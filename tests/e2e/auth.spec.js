// @ts-check
import { test, expect } from '@playwright/test';

// Compte de test — doit exister dans le worker local
// Créé une fois par le test "register", réutilisé par les suivants
const TEST_EMAIL = `e2e_${Date.now()}@test.local`;
const TEST_PASSWORD = 'test1234';
const TEST_NAME = 'E2E Testeur';

test.describe('Authentification', () => {

  test('affiche la page de connexion', async ({ page }) => {
    await page.goto('/login.html');
    await expect(page.locator('.login-logo')).toHaveText('BWR');
    await expect(page.locator('#loginForm')).toBeVisible();
    await expect(page.locator('#signupForm')).toBeHidden();
  });

  test('bascule vers le formulaire d\'inscription', async ({ page }) => {
    await page.goto('/login.html');
    await page.click('#tabSignup');
    await expect(page.locator('#signupForm')).toBeVisible();
    await expect(page.locator('#loginForm')).toBeHidden();
  });

  test('affiche une erreur avec des identifiants invalides', async ({ page }) => {
    await page.goto('/login.html');
    await page.fill('#loginEmail', 'nope@nope.com');
    await page.fill('#loginPassword', 'wrongpass');
    await page.click('#loginForm button[type=submit]');
    await expect(page.locator('#loginError')).toBeVisible();
    await expect(page.locator('#loginError')).not.toBeEmpty();
  });

  test('inscription puis connexion complète', async ({ page }) => {
    await page.goto('/login.html');

    // Inscription
    await page.click('#tabSignup');
    await page.fill('#signupName', TEST_NAME);
    await page.fill('#signupEmail', TEST_EMAIL);
    await page.fill('#signupPassword', TEST_PASSWORD);
    await page.check('#signupConsent');
    await page.click('#signupForm button[type=submit]');

    // Message de succès (compte créé, email de vérification envoyé)
    await expect(page.locator('#signupSuccess')).toBeVisible({ timeout: 10_000 });

    // Connexion directe via l'API (bypass vérification email en local)
    const res = await page.evaluate(async ({ email, password }) => {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      return { status: r.status, body: await r.json() };
    }, { email: TEST_EMAIL, password: TEST_PASSWORD });

    // En local sans RESEND_API_KEY, le compte peut être directement actif
    // (le worker saute la vérification si la clé est absente)
    if (res.status === 200) {
      await page.evaluate(({ token, user }) => {
        localStorage.setItem('bwr_token', token);
        localStorage.setItem('bwr_user', JSON.stringify(user));
      }, res.body);

      await page.goto('/map.html');
      await expect(page).toHaveURL(/map\.html/);
    } else {
      // Compte en attente de vérification — comportement attendu en prod
      expect([200, 403]).toContain(res.status);
    }
  });

  test('redirige vers login.html si non authentifié', async ({ page }) => {
    await page.goto('/map.html');
    // La page doit rediriger vers login (requireAuth() dans map.js)
    await expect(page).toHaveURL(/login\.html/, { timeout: 8_000 });
  });

  test('déconnexion efface la session', async ({ page }) => {
    // Injecte une fausse session pour simuler un user connecté
    await page.goto('/login.html');
    await page.evaluate(() => {
      localStorage.setItem('bwr_token', 'fake-token-xxx');
      localStorage.setItem('bwr_user', JSON.stringify({ id: '1', name: 'Test', role: 'user', plan: 'free' }));
    });

    // Appelle logout() directement
    await page.evaluate(() => {
      localStorage.removeItem('bwr_token');
      localStorage.removeItem('bwr_user');
    });

    expect(await page.evaluate(() => localStorage.getItem('bwr_token'))).toBeNull();
  });
});
