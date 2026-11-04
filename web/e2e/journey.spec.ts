import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// With BASE_PATH set, the app runs under that path (like /openmutual) behind a strict proxy.
const BASE = (process.env.BASE_PATH ?? '').replace(/\/+$/, '');

// The docs screenshots come from the normal run. A run under a path keeps its own.
const SHOTS = BASE ? join(__dirname, '../test-results/shots-under-path') : join(__dirname, '../../docs/screenshots');
mkdirSync(SHOTS, { recursive: true });
const shot = (page: Page, name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });

/** A page inside the app. Under a path, pages end in a slash. */
function at(path: string): string {
  if (!BASE) return path;
  const [route, query] = path.split('?');
  return `${BASE}${route.endsWith('/') ? route : `${route}/`}${query ? `?${query}` : ''}`;
}
const go = (page: Page, path: string) => page.goto(at(path));
/** The page's URL is this app page, with the base in front when there is one. */
const onPage = (name: string) => new RegExp(`${BASE}/${name}/?$`);

// Every request the browser makes has to stay under the base, or the proxy would send it elsewhere.
let strays: string[] = [];
test.beforeEach(({ page, baseURL }) => {
  strays = [];
  if (!BASE) return;
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === baseURL && !url.pathname.startsWith(`${BASE}/`)) strays.push(`${request.method()} ${url.pathname}`);
  });
});
test.afterEach(() => {
  expect(strays, 'requests outside the base path').toEqual([]);
});

async function signIn(page: Page, email: string) {
  await go(page, '/login');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Get a code' }).click();
  const code = await page.getByTestId('login-code').textContent();
  await page.getByLabel('Code').fill(code ?? '');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(onPage('pool'));
}

async function skip(page: Page, label: 'Skip 1 day' | 'Skip 7 days') {
  await page.getByRole('button', { name: label }).click();
  await expect(page.getByText(/^Skipped \d days?\.$/)).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test('a new person can back the pool, buy cover, get paid and withdraw, without help', async ({ page }) => {
  await go(page, '/');
  await expect(page.getByText('Simulation with test money.')).toBeVisible();
  await shot(page, 'home');

  await signIn(page, 'journey@test.local');
  await expect(page.getByTestId('balance')).toHaveText('10,000.00 tUSD');

  await page.getByLabel('Amount in test dollars').fill('2000');
  await page.getByRole('button', { name: 'Deposit' }).click();
  await expect(page.getByText('Deposited 2,000 test dollars.')).toBeVisible();
  await expect(page.getByTestId('pool-value')).toHaveText('2,000.00 tUSD');

  await page.getByRole('link', { name: 'Get test cover' }).click();
  await shot(page, 'cover');
  await page.getByRole('link', { name: /^Choose TA/ }).first().click();
  const price = await page.getByTestId('price').textContent();
  await page.getByRole('button', { name: `Buy for ${price}` }).click();
  await expect(page).toHaveURL(onPage('my-covers'));
  await expect(page.getByTestId('status')).toHaveText('Active');

  // The demo switch decides the flight is late. The fake sources still report it, and the worker still settles it.
  await go(page, '/admin');
  await page.getByLabel('Admin token').fill('e2e-local-admin');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel(/^Result for/).fill('240');
  await page.getByRole('button', { name: 'Set result' }).click();
  await expect(page.getByText(/set to 240/)).toBeVisible();

  // A day at a time: the flight has to leave, two sources have to agree, then the 1 hour window has to pass.
  await go(page, '/my-covers');
  const paidOut = (timeout: number) =>
    expect
      .poll(async () => {
        await page.reload();
        return page.getByTestId('status').textContent();
      }, { timeout })
      .toBe('Paid out')
      .then(() => true, () => false);
  let paid = false;
  for (let day = 0; day < 5 && !paid; day++) {
    await skip(page, 'Skip 1 day');
    paid = await paidOut(6_000);
  }
  expect(paid).toBe(true);
  await expect(page.getByText('240 minutes late')).toBeVisible();
  await shot(page, 'my-covers');

  await go(page, '/pool');
  await page.getByRole('button', { name: 'Start the wait' }).click();
  await expect(page.getByText('Your wait has started.')).toBeVisible();
  await skip(page, 'Skip 7 days');
  await expect.poll(async () => {
    await page.reload();
    return page.getByTestId('pool-value').textContent();
  }).toBe('0.00 tUSD');

  await go(page, '/numbers');
  await expect(page.getByTestId('covers-sold')).toHaveText('1');
  await expect(page.getByTestId('paid-out')).toHaveText('100.00 tUSD');
  await shot(page, 'numbers');
});

test('a lost bag claim climbs the claims ladder and pays, and a member can join the jury', async ({ page }) => {
  await signIn(page, 'ladder@test.local');
  await go(page, '/cover?product=lost-bag');
  await expect(page.getByTestId('wording')).toContainText('48 hours');
  await page.getByRole('button', { name: 'See the price' }).click();
  await page.getByRole('button', { name: /^Buy for/ }).click();
  await expect(page).toHaveURL(onPage('my-covers'));

  await page.getByText('Something went wrong? File a claim').click();
  await page.getByLabel('What happened?').fill('My bag never came off the belt in Rome.');
  await page.getByRole('button', { name: 'Send the claim' }).click();
  // The form goes once the claim is filed, and the claim shows where it is on the ladder.
  await expect(page.getByTestId('ladder-stage')).toBeVisible();
  await expect(page.getByRole('blockquote')).toHaveText('My bag never came off the belt in Rome.');

  // The fake AI panel answers alone and in secret, then the answers open together.
  await expect.poll(async () => {
    await page.reload();
    return page.getByTestId('panel-answers').locator('li').count();
  }, { timeout: 30_000 }).toBe(5);
  await expect(page.getByTestId('status')).toHaveText('Claim being decided');
  await shot(page, 'claim-ladder');

  const paidOut = () =>
    expect
      .poll(async () => {
        await page.reload();
        return page.getByTestId('status').textContent();
      }, { timeout: 6_000 })
      .toBe('Paid out')
      .then(() => true, () => false);
  let paid = false;
  for (let day = 0; day < 8 && !paid; day++) {
    await skip(page, 'Skip 1 day');
    paid = await paidOut();
  }
  expect(paid).toBe(true);
  await expect(page.getByText('200.00 tUSD went to your wallet.')).toBeVisible();

  await go(page, '/community');
  await page.getByLabel('Name').fill('Made Up Person');
  await page.getByLabel('Country').fill('Italy');
  await page.getByRole('button', { name: 'Run the fake check' }).click();
  // The form goes once you're a member, and the page says so.
  await expect(page.getByText("You're a member.", { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Join the jury pool' }).click();
  await expect(page.getByText(/You're in the jury pool\./).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'AI assessors' })).toBeVisible();
  await expect(page.getByRole('row', { name: /^Northwind Northwind/ })).toBeVisible();
  await shot(page, 'community-ladder');
});

test('wrong login codes are turned down', async ({ page }) => {
  await go(page, '/login');
  await page.getByLabel('Email').fill('wrong-code@test.local');
  await page.getByRole('button', { name: 'Get a code' }).click();
  await page.getByLabel('Code').fill('000000');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toHaveText("That code isn't right.");
});

test('signed out visitors are sent to sign in', async ({ page }) => {
  for (const path of ['/pool', '/my-covers']) {
    await go(page, path);
    await expect(page).toHaveURL(onPage('login'));
  }
});

test('admin needs the token', async ({ page }) => {
  await go(page, '/admin');
  await page.getByLabel('Admin token').fill('not-the-token');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Open events' })).toHaveCount(0);
});

test('every page fits a phone screen', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, 'phone@test.local');
  for (const path of ['/', '/cover', '/cover?product=rainy-day', '/my-covers', '/pool', '/numbers', '/community', '/feedback', '/terms', '/privacy', '/admin']) {
    await go(page, path);
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width, `${path} scrolls sideways`).toBeLessThanOrEqual(375);
  }
  await go(page, '/community');
  await shot(page, 'community-phone');
});

test('under a path, the app keeps to it', async ({ page, request, context }) => {
  test.skip(!BASE, 'Only runs with BASE_PATH set');
  const bare = await request.get(BASE, { maxRedirects: 0 });
  expect(bare.status()).toBe(301);
  expect(bare.headers().location).toBe(`${BASE}/`);

  await signIn(page, 'path@test.local');
  const session = (await context.cookies()).find((cookie) => cookie.name === 'om_session');
  expect(session?.path).toBe(BASE);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
  expect((await context.cookies()).find((cookie) => cookie.name === 'om_session')).toBeUndefined();

  // The GET form on the cover page and the brand link both stay under the path.
  await go(page, '/cover');
  await page.getByRole('button', { name: 'Show flights' }).click();
  await expect(page).toHaveURL(new RegExp(`${BASE}/cover/\\?`));
  await page.getByRole('link', { name: /^OpenMutual/ }).click();
  await expect(page).toHaveURL(new RegExp(`${BASE}/$`));
});
