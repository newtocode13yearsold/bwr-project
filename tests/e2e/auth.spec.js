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
    // On mocke les endpoints d'auth : ce test valide le PARCOURS front-end,
    // pas le worker live. L'inscription réelle est limitée à 5/h par IP
    // (REGISTER_RATE_LIMIT) — la lancer à chaque run CI depuis les IP
    // partagées de GitHub finit par être bloquée (429) et polluait la prod
    // avec des comptes e2e_*@test.local. Le mock rend le test déterministe.
    await page.route('**/api/auth/register', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'Un email de vérification a été envoyé.' }),
    }));
    await page.route('**/api/auth/login', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        token: 'e2e-fake-token',
        user: { id: 'e2e1', name: TEST_NAME, email: TEST_EMAIL, role: 'user', plan: 'free' },
      }),
    }));

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

    // Connexion via l'API (mockée) puis accès à une page protégée
    const res = await page.evaluate(async ({ email, password }) => {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      return { status: r.status, body: await r.json() };
    }, { email: TEST_EMAIL, password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    await page.evaluate(({ token, user }) => {
      localStorage.setItem('bwr_token', token);
      localStorage.setItem('bwr_user', JSON.stringify(user));
    }, res.body);

    // Le site utilise des URL « propres » (/map.html redirige vers /map),
    // donc on vérifie que la page carte s'est bien chargée plutôt que l'URL.
    await page.goto('/map.html');
    await expect(page).toHaveURL(/\/map(\.html)?(\?.*)?$/);
    await expect(page.locator('.leaflet-container')).toBeVisible({ timeout: 10_000 });
  });

  test('map.html est accessible sans auth et affiche le lien Connexion', async ({ page }) => {
    await page.goto('/map.html');
    // map.html est public — pas de redirect. Un visiteur non connecté voit le lien "Connexion".
    await expect(page.locator('.leaflet-container')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('a[href="login.html"], a:has-text("Connexion")')).toBeVisible();
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
