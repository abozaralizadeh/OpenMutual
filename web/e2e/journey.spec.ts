import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const SHOTS = join(__dirname, '../../docs/screenshots');
mkdirSync(SHOTS, { recursive: true });
const shot = (page: Page, name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });

async function signIn(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Get a code' }).click();
  const code = await page.getByTestId('login-code').textContent();
  await page.getByLabel('Code').fill(code ?? '');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/pool$/);
}

async function skip(page: Page, label: 'Skip 1 day' | 'Skip 7 days') {
  await page.getByRole('button', { name: label }).click();
  await expect(page.getByText(/^Skipped \d days?\.$/)).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test('a new person can back the pool, buy cover, get paid and withdraw, without help', async ({ page }) => {
  await page.goto('/');
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
  await expect(page).toHaveURL(/\/my-covers$/);
  await expect(page.getByTestId('status')).toHaveText('Active');

  // The demo switch decides the flight is late. The fake sources still report it, and the worker still settles it.
  await page.goto('/admin');
  await page.getByLabel('Admin token').fill('e2e-local-admin');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel(/^Result for/).fill('240');
  await page.getByRole('button', { name: 'Set result' }).click();
  await expect(page.getByText(/set to 240/)).toBeVisible();

  // A day at a time: the flight has to leave, two sources have to agree, then the 1 hour window has to pass.
  await page.goto('/my-covers');
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

  await page.goto('/pool');
  await page.getByRole('button', { name: 'Start the wait' }).click();
  await expect(page.getByText('Your wait has started.')).toBeVisible();
  await skip(page, 'Skip 7 days');
  await expect.poll(async () => {
    await page.reload();
    return page.getByTestId('pool-value').textContent();
  }).toBe('0.00 tUSD');

  await page.goto('/numbers');
  await expect(page.getByTestId('covers-sold')).toHaveText('1');
  await expect(page.getByTestId('paid-out')).toHaveText('100.00 tUSD');
  await shot(page, 'numbers');
});

test('a lost bag claim climbs the claims ladder and pays, and a member can join the jury', async ({ page }) => {
  await signIn(page, 'ladder@test.local');
  await page.goto('/cover?product=lost-bag');
  await expect(page.getByTestId('wording')).toContainText('48 hours');
  await page.getByRole('button', { name: 'See the price' }).click();
  await page.getByRole('button', { name: /^Buy for/ }).click();
  await expect(page).toHaveURL(/\/my-covers$/);

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

  await page.goto('/community');
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
  await page.goto('/login');
  await page.getByLabel('Email').fill('wrong-code@test.local');
  await page.getByRole('button', { name: 'Get a code' }).click();
  await page.getByLabel('Code').fill('000000');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toHaveText("That code isn't right.");
});

test('signed out visitors are sent to sign in', async ({ page }) => {
  for (const path of ['/pool', '/my-covers']) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/login$/);
  }
});

test('admin needs the token', async ({ page }) => {
  await page.goto('/admin');
  await page.getByLabel('Admin token').fill('not-the-token');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Open events' })).toHaveCount(0);
});

test('every page fits a phone screen', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, 'phone@test.local');
  for (const path of ['/', '/cover', '/cover?product=rainy-day', '/my-covers', '/pool', '/numbers', '/community', '/feedback', '/terms', '/privacy', '/admin']) {
    await page.goto(path);
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width, `${path} scrolls sideways`).toBeLessThanOrEqual(375);
  }
  await page.goto('/community');
  await shot(page, 'community-phone');
});
