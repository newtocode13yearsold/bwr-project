# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: auth.spec.js >> Authentification >> inscription puis connexion complète
- Location: tests\e2e\auth.spec.js:35:7

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator:  locator('#signupSuccess')
Expected: visible
Received: hidden
Timeout:  10000ms

Call log:
  - Expect "toBeVisible" with timeout 10000ms
  - waiting for locator('#signupSuccess')
    23 × locator resolved to <div id="signupSuccess" class="form-success hidden"></div>
       - unexpected value "hidden"

```

```yaml
- link "← Retour à l'accueil":
  - /url: /
- text: BWR
- paragraph: La carte qui simplifie ta vie
- button "Se connecter"
- button "S'inscrire"
- text: Prénom et nom
- textbox "Thomas Legros": E2E Testeur
- text: Email
- textbox "ton@email.com": e2e_1780777763645@test.local
- text: Mot de passe
- textbox "8 caractères minimum": test1234
- button "Afficher le mot de passe":
  - img
- checkbox "J'ai lu et j'accepte les CGU et la politique de confidentialité" [checked]
- text: J'ai lu et j'accepte les
- link "CGU et la politique de confidentialité":
  - /url: legal
- text: Votre compte a été créé mais l'envoi de l'email de vérification a échoué. Utilisez le bouton « Renvoyer l'email » sur la page de connexion.
- button "Créer mon compte"
```

# Test source

```ts
  1  | // @ts-check
  2  | import { test, expect } from '@playwright/test';
  3  | 
  4  | // Compte de test — doit exister dans le worker local
  5  | // Créé une fois par le test "register", réutilisé par les suivants
  6  | const TEST_EMAIL = `e2e_${Date.now()}@test.local`;
  7  | const TEST_PASSWORD = 'test1234';
  8  | const TEST_NAME = 'E2E Testeur';
  9  | 
  10 | test.describe('Authentification', () => {
  11 | 
  12 |   test('affiche la page de connexion', async ({ page }) => {
  13 |     await page.goto('/login.html');
  14 |     await expect(page.locator('.login-logo')).toHaveText('BWR');
  15 |     await expect(page.locator('#loginForm')).toBeVisible();
  16 |     await expect(page.locator('#signupForm')).toBeHidden();
  17 |   });
  18 | 
  19 |   test('bascule vers le formulaire d\'inscription', async ({ page }) => {
  20 |     await page.goto('/login.html');
  21 |     await page.click('#tabSignup');
  22 |     await expect(page.locator('#signupForm')).toBeVisible();
  23 |     await expect(page.locator('#loginForm')).toBeHidden();
  24 |   });
  25 | 
  26 |   test('affiche une erreur avec des identifiants invalides', async ({ page }) => {
  27 |     await page.goto('/login.html');
  28 |     await page.fill('#loginEmail', 'nope@nope.com');
  29 |     await page.fill('#loginPassword', 'wrongpass');
  30 |     await page.click('#loginForm button[type=submit]');
  31 |     await expect(page.locator('#loginError')).toBeVisible();
  32 |     await expect(page.locator('#loginError')).not.toBeEmpty();
  33 |   });
  34 | 
  35 |   test('inscription puis connexion complète', async ({ page }) => {
  36 |     await page.goto('/login.html');
  37 | 
  38 |     // Inscription
  39 |     await page.click('#tabSignup');
  40 |     await page.fill('#signupName', TEST_NAME);
  41 |     await page.fill('#signupEmail', TEST_EMAIL);
  42 |     await page.fill('#signupPassword', TEST_PASSWORD);
  43 |     await page.check('#signupConsent');
  44 |     await page.click('#signupForm button[type=submit]');
  45 | 
  46 |     // Message de succès (compte créé, email de vérification envoyé)
> 47 |     await expect(page.locator('#signupSuccess')).toBeVisible({ timeout: 10_000 });
     |                                                  ^ Error: expect(locator).toBeVisible() failed
  48 | 
  49 |     // Connexion directe via l'API (bypass vérification email en local)
  50 |     const res = await page.evaluate(async ({ email, password }) => {
  51 |       const r = await fetch('/api/auth/login', {
  52 |         method: 'POST',
  53 |         headers: { 'Content-Type': 'application/json' },
  54 |         body: JSON.stringify({ email, password }),
  55 |       });
  56 |       return { status: r.status, body: await r.json() };
  57 |     }, { email: TEST_EMAIL, password: TEST_PASSWORD });
  58 | 
  59 |     // En local sans RESEND_API_KEY, le compte peut être directement actif
  60 |     // (le worker saute la vérification si la clé est absente)
  61 |     if (res.status === 200) {
  62 |       await page.evaluate(({ token, user }) => {
  63 |         localStorage.setItem('bwr_token', token);
  64 |         localStorage.setItem('bwr_user', JSON.stringify(user));
  65 |       }, res.body);
  66 | 
  67 |       await page.goto('/map.html');
  68 |       await expect(page).toHaveURL(/map\.html/);
  69 |     } else {
  70 |       // Compte en attente de vérification — comportement attendu en prod
  71 |       expect([200, 403]).toContain(res.status);
  72 |     }
  73 |   });
  74 | 
  75 |   test('map.html est accessible sans auth et affiche le lien Connexion', async ({ page }) => {
  76 |     await page.goto('/map.html');
  77 |     // map.html est public — pas de redirect. Un visiteur non connecté voit le lien "Connexion".
  78 |     await expect(page.locator('.leaflet-container')).toBeVisible({ timeout: 10_000 });
  79 |     await expect(page.locator('a[href="login.html"], a:has-text("Connexion")')).toBeVisible();
  80 |   });
  81 | 
  82 |   test('déconnexion efface la session', async ({ page }) => {
  83 |     // Injecte une fausse session pour simuler un user connecté
  84 |     await page.goto('/login.html');
  85 |     await page.evaluate(() => {
  86 |       localStorage.setItem('bwr_token', 'fake-token-xxx');
  87 |       localStorage.setItem('bwr_user', JSON.stringify({ id: '1', name: 'Test', role: 'user', plan: 'free' }));
  88 |     });
  89 | 
  90 |     // Appelle logout() directement
  91 |     await page.evaluate(() => {
  92 |       localStorage.removeItem('bwr_token');
  93 |       localStorage.removeItem('bwr_user');
  94 |     });
  95 | 
  96 |     expect(await page.evaluate(() => localStorage.getItem('bwr_token'))).toBeNull();
  97 |   });
  98 | });
  99 | 
```