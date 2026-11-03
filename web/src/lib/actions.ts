'use server';

import { randomInt } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { Hex } from 'viem';
import {
  askToWithdraw,
  bagOffer,
  becomeMember,
  buyCover,
  chainNow,
  countUse,
  createUser,
  depositToPool,
  emailHash,
  fakeMailer,
  fileClaim,
  flightOffer,
  flightRef,
  friendlyError,
  fromUsd,
  getMoreTestMoney,
  hashSecret,
  makeQuote,
  pendingTeamChanges,
  proposeChange,
  rainOffer,
  rainRef,
  rejectResult,
  saveFeedback,
  setDemoResult,
  setPaused,
  skipTime,
  teamExecute,
  teamSchedule,
  userAccount,
  voteOnClaim,
  voteOnProposal,
  VOTABLE_SETTINGS,
  walletNumbers,
  type User,
  type VotableSetting,
} from '@openmutual/shared';
import { currentUser, endSession, getApp, isAdmin, log, publicClockOn, startAdmin, startSession } from './server';

export interface ActionState {
  error?: string;
  ok?: string;
  code?: string;
  step?: 'code';
  email?: string;
}

const mailer = fakeMailer();
const CODE_MINUTES = 10;
const MAX_CODE_TRIES = 5;

async function needUser(): Promise<User> {
  const user = await currentUser();
  if (!user) redirect('/login');
  return user;
}

async function needAdmin() {
  if (!(await isAdmin())) throw new Error('Admin only.');
}

/** Runs an action and turns any failure into a sentence for the form. */
async function attempt(work: () => Promise<string>): Promise<ActionState> {
  try {
    const ok = await work();
    revalidatePath('/', 'layout');
    return { ok };
  } catch (error) {
    if (error && typeof error === 'object' && 'digest' in error) throw error;
    const plain = error instanceof Error && !('shortMessage' in error) && !error.message.includes('revert');
    const message = plain ? error.message : friendlyError(error);
    log.warn(`Action turned down: ${message}`);
    return { error: message };
  }
}

function positive(value: FormDataEntryValue | null, name = 'amount'): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`Enter a valid ${name}.`);
  return number;
}

// Signing in

export async function startLogin(_: ActionState, form: FormData): Promise<ActionState> {
  const email = String(form.get('email') ?? '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: 'Enter a valid email address.' };
  const code = String(randomInt(100_000, 1_000_000));
  const expires = Math.floor(Date.now() / 1000) + CODE_MINUTES * 60;
  getApp()
    .db.prepare(
      `INSERT INTO login_codes (email_hash, code_hash, expires_at, tries) VALUES (?, ?, ?, 0)
       ON CONFLICT(email_hash) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, tries = 0`,
    )
    .run(emailHash(email), hashSecret(code), expires);
  await mailer.sendCode(email, code);
  return { step: 'code', email, code: mailer.showsCodeOnScreen ? code : undefined };
}

export async function finishLogin(_: ActionState, form: FormData): Promise<ActionState> {
  const email = String(form.get('email') ?? '');
  const code = String(form.get('code') ?? '').trim();
  const app = getApp();
  const hash = emailHash(email);
  const row = app.db.prepare('SELECT code_hash, expires_at, tries FROM login_codes WHERE email_hash = ?').get(hash) as
    | { code_hash: string; expires_at: number; tries: number }
    | undefined;
  const expired = !row || row.expires_at < Date.now() / 1000 || row.tries >= MAX_CODE_TRIES;
  if (expired) return { step: 'code', email, error: 'That code has expired. Go back and ask for a new one.' };
  if (row.code_hash !== hashSecret(code)) {
    app.db.prepare('UPDATE login_codes SET tries = tries + 1 WHERE email_hash = ?').run(hash);
    return { step: 'code', email, error: "That code isn't right." };
  }
  app.db.prepare('DELETE FROM login_codes WHERE email_hash = ?').run(hash);
  const user = await createUser(app, email);
  await startSession(user.id);
  countUse(app.db, 'login');
  redirect('/pool');
}

export async function logout() {
  await endSession();
  redirect('/');
}

// Test money and the clock

export async function moreTestMoney(_: ActionState): Promise<ActionState> {
  const user = await needUser();
  return attempt(async () => {
    await getMoreTestMoney(getApp(), user);
    return 'Added 10,000 test dollars.';
  });
}

export async function skipClock(_: ActionState, form: FormData): Promise<ActionState> {
  if (!publicClockOn() && !(await isAdmin())) return { error: 'The clock is locked for this test.' };
  const days = Number(form.get('days'));
  if (days !== 1 && days !== 7) return { error: 'Pick 1 or 7 days.' };
  return attempt(async () => {
    await skipTime(getApp().client, days * 86_400);
    countUse(getApp().db, 'clock_skip');
    return `Skipped ${days} day${days === 1 ? '' : 's'}.`;
  });
}

// Cover

function offerFrom(form: FormData, wallet: `0x${string}`) {
  const app = getApp();
  const product = String(form.get('product'));
  const date = String(form.get('date'));
  if (product === 'flight-delay') return flightOffer(app, String(form.get('subject')), date);
  if (product === 'rainy-day') return rainOffer(app, String(form.get('subject')), date);
  if (product === 'lost-bag') return bagOffer(app, wallet, date);
  throw new Error('Unknown product.');
}

export async function buy(_: ActionState, form: FormData): Promise<ActionState> {
  const user = await needUser();
  const app = getApp();
  const result = await attempt(async () => {
    const quote = await makeQuote(app, offerFrom(form, user.wallet), user.wallet);
    await buyCover(app, user, quote);
    return 'Done.';
  });
  if (result.error) return result;
  redirect('/my-covers');
}

export async function submitClaim(_: ActionState, form: FormData): Promise<ActionState> {
  const user = await needUser();
  const text = String(form.get('evidence') ?? '').trim();
  if (text.length < 5) return { error: 'Say what happened in a few words.' };
  return attempt(async () => {
    await fileClaim(getApp(), user, Number(form.get('coverId')), text.slice(0, 1000));
    return 'Sent to members for a vote.';
  });
}

// The pool

export async function deposit(_: ActionState, form: FormData): Promise<ActionState> {
  const user = await needUser();
  return attempt(async () => {
    const amount = positive(form.get('amount'));
    await depositToPool(getApp(), user, fromUsd(amount));
    return `Deposited ${amount.toLocaleString('en-GB')} test dollars.`;
  });
}

export async function withdraw(_: ActionState, form: FormData): Promise<ActionState> {
  const user = await needUser();
  return attempt(async () => {
    const app = getApp();
    const share = positive(form.get('percent'), 'percentage');
    if (share > 100) throw new Error('Pick 100% or less.');
    const { shares } = await walletNumbers(app, user.wallet);
    const amount = (shares * BigInt(Math.round(share * 100))) / 10_000n;
    if (amount === 0n) throw new Error("You don't have any pool shares to withdraw.");
    await askToWithdraw(app, user, amount);
    return 'Your wait has started. Your shares still share gains and losses until they are paid.';
  });
}

// Community

export async function join(_: ActionState, form: FormData): Promise<ActionState> {
  const user = await needUser();
  const fullName = String(form.get('fullName') ?? '').trim();
  const country = String(form.get('country') ?? '').trim();
  if (fullName.length < 2 || country.length < 2) return { error: 'Fill in both boxes.' };
  return attempt(async () => {
    await becomeMember(getApp(), user, { fullName, country });
    return "You're a member now. You can vote on anything that opens from here on.";
  });
}

export async function claimVote(_: ActionState, form: FormData): Promise<ActionState> {
  const user = await needUser();
  return attempt(async () => {
    await voteOnClaim(getApp(), userAccount(user), Number(form.get('id')), form.get('choice') === 'yes');
    return 'Vote counted.';
  });
}

export async function proposalVote(_: ActionState, form: FormData): Promise<ActionState> {
  const user = await needUser();
  return attempt(async () => {
    await voteOnProposal(getApp(), userAccount(user), Number(form.get('id')), form.get('choice') === 'yes');
    return 'Vote counted.';
  });
}

function settingFrom(form: FormData): { setting: VotableSetting; value: number } {
  const setting = String(form.get('setting')) as VotableSetting;
  if (!(setting in VOTABLE_SETTINGS)) throw new Error('Unknown setting.');
  const value = Number(form.get('value'));
  if (!Number.isFinite(value) || value < 0) throw new Error('Enter a valid value.');
  return { setting, value };
}

export async function propose(_: ActionState, form: FormData): Promise<ActionState> {
  const user = await needUser();
  return attempt(async () => {
    const { setting, value } = settingFrom(form);
    await proposeChange(getApp(), userAccount(user), setting, value, String(form.get('note') ?? '').slice(0, 300));
    return 'Proposal opened for a vote.';
  });
}

// Feedback

export async function sendFeedback(_: ActionState, form: FormData): Promise<ActionState> {
  const text = String(form.get('text') ?? '').trim();
  if (text.length < 3) return { error: 'Write a few words first.' };
  const rating = Number(form.get('rating'));
  saveFeedback(getApp(), rating >= 1 && rating <= 5 ? rating : null, text);
  return { ok: 'Thanks. Got it.' };
}

// Admin

export async function adminLogin(_: ActionState, form: FormData): Promise<ActionState> {
  if (await startAdmin(String(form.get('token') ?? ''))) redirect('/admin');
  return { error: "That isn't right, or ADMIN_TOKEN isn't set." };
}

export async function adminPause(_: ActionState, form: FormData): Promise<ActionState> {
  await needAdmin();
  return attempt(async () => {
    const paused = form.get('paused') === 'true';
    await setPaused(getApp(), paused);
    return paused ? 'Sales and deposits paused.' : 'Back open.';
  });
}

export async function adminDemoResult(_: ActionState, form: FormData): Promise<ActionState> {
  await needAdmin();
  return attempt(async () => {
    const kind = String(form.get('kind'));
    const subject = String(form.get('subject'));
    const date = String(form.get('date'));
    const value = Number(form.get('value'));
    if (!Number.isInteger(value) || value < 0) throw new Error('Enter a whole number.');
    setDemoResult(getApp(), kind === 'flight' ? flightRef(subject, date) : rainRef(subject, date), value);
    return `Result for ${subject} set to ${value}. The fake sources will report it when the event is due.`;
  });
}

export async function adminReject(_: ActionState, form: FormData): Promise<ActionState> {
  await needAdmin();
  return attempt(async () => {
    await rejectResult(getApp(), String(form.get('key')) as Hex);
    return 'Result rejected. Sources will report again.';
  });
}

export async function adminSchedule(_: ActionState, form: FormData): Promise<ActionState> {
  await needAdmin();
  return attempt(async () => {
    const { setting, value } = settingFrom(form);
    await teamSchedule(getApp(), setting, value);
    return 'Two test signers approved it. It can run after the delay.';
  });
}

export async function adminExecute(_: ActionState, form: FormData): Promise<ActionState> {
  await needAdmin();
  return attempt(async () => {
    const app = getApp();
    const change = pendingTeamChanges(app).find((item) => item.salt === form.get('salt'));
    if (!change) throw new Error('That change is gone.');
    if ((await chainNow(app.client)) < change.readyAt) throw new Error('The delay has not passed yet.');
    await teamExecute(app, change);
    return 'Change applied.';
  });
}
