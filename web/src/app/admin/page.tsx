import { chainNow, coverTotals, CANCELLED, allFeedback, openCovers, pendingTeamChanges, poolNumbers, resultOf, usageTotals, VOTABLE_SETTINGS, productForCover } from '@openmutual/shared';
import type { Hex } from 'viem';
import { ActionForm } from '@/components/ActionForm';
import { adminDemoResult, adminExecute, adminLogin, adminPause, adminReject, adminSchedule } from '@/lib/actions';
import { dateTime, duration } from '@/lib/format';
import { adminToken, isAdmin, syncedApp } from '@/lib/server';

export default async function Admin() {
  if (!(await isAdmin())) {
    return (
      <div className="card" style={{ maxWidth: 440 }}>
        <h1>Admin</h1>
        {adminToken() ? null : <p className="callout warn">ADMIN_TOKEN isn&apos;t set, so nobody can sign in here.</p>}
        <ActionForm action={adminLogin} submit="Sign in">
          <label>Admin token<input name="token" type="password" required autoComplete="off" /></label>
        </ActionForm>
      </div>
    );
  }

  const app = await syncedApp();
  const [numbers, now] = await Promise.all([poolNumbers(app), chainNow(app.client)]);
  const open = openCovers(app).filter((cover) => productForCover(app, cover).kind === 'automatic');
  const seen = new Set<string>();
  const events = open.filter((cover) => !seen.has(cover.event_key) && Boolean(seen.add(cover.event_key)));
  const withResults = await Promise.all(events.map(async (cover) => ({ cover, result: await resultOf(app, cover.event_key as Hex) })));
  const changes = pendingTeamChanges(app);
  const totals = coverTotals(app);

  return (
    <>
      <h1>Admin</h1>
      <p className="lead">Simulation tools. Pausing and rejecting a result work right away. Setting changes go through two signers and a 1 day delay.</p>

      <section className="split">
        <div className="card">
          <h2>Pause</h2>
          <p>{numbers.paused ? 'Sales and deposits are paused.' : 'Sales and deposits are open.'} Payouts and withdrawals never pause.</p>
          <ActionForm action={adminPause} submit={numbers.paused ? 'Open again' : 'Pause'}>
            <input type="hidden" name="paused" value={String(!numbers.paused)} />
          </ActionForm>
        </div>
        <div className="card">
          <h2>Change a setting</h2>
          <ActionForm action={adminSchedule} submit="Approve with two test signers">
            <label>
              Setting
              <select name="setting">
                {Object.entries(VOTABLE_SETTINGS).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}
              </select>
            </label>
            <label>New value<input name="value" type="number" min="0" required /></label>
          </ActionForm>
          {changes.map((change) => (
            <div key={change.salt} className="row small" style={{ marginTop: 10 }}>
              <span>{VOTABLE_SETTINGS[change.setting].label}: {change.value}. {change.readyAt > now ? `Ready in ${duration(change.readyAt - now)}.` : 'Ready.'}</span>
              <ActionForm action={adminExecute} submit="Apply" quiet>
                <input type="hidden" name="salt" value={change.salt} />
              </ActionForm>
            </div>
          ))}
        </div>
      </section>

      <section className="section card">
        <h2>Open events</h2>
        <p className="small muted">
          Force what the fake sources will report, for a demo. For flights the value is minutes late, and {CANCELLED} means cancelled. For rain it&apos;s mm.
        </p>
        {withResults.length === 0 ? <p className="muted">Nothing open.</p> : (
          <div className="stack">
            {withResults.map(({ cover, result }) => {
              const details = JSON.parse(cover.details ?? '{}');
              return (
                <div key={cover.event_key} className="row" style={{ justifyContent: 'space-between', borderTop: '1px solid var(--line)', paddingTop: 10 }}>
                  <div>
                    <strong>{cover.label}</strong>
                    <div className="small muted">
                      {dateTime(cover.event_time)}. {result.decided ? `Decided: ${result.value}.` : 'No result yet.'}
                    </div>
                  </div>
                  <div className="row">
                    <ActionForm action={adminDemoResult} submit="Set result" quiet className="row">
                      <input type="hidden" name="kind" value={details.kind} />
                      <input type="hidden" name="subject" value={details.subject} />
                      <input type="hidden" name="date" value={details.date} />
                      <input name="value" type="number" min="0" required aria-label={`Result for ${cover.label}`} style={{ width: 130 }} />
                    </ActionForm>
                    {result.decided ? (
                      <ActionForm action={adminReject} submit="Reject result" quiet>
                        <input type="hidden" name="key" value={cover.event_key} />
                      </ActionForm>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="section split">
        <div className="card">
          <h2>Usage</h2>
          <p className="small muted">Daily totals only, not linked to anyone.</p>
          <div className="table-wrap">
            <table>
              <tbody>
                {usageTotals(app).map((row) => <tr key={row.name}><td>{row.name}</td><td className="num">{row.count}</td></tr>)}
                <tr><td>covers sold</td><td className="num">{totals.sold}</td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <div className="card">
          <h2>Feedback</h2>
          {allFeedback(app).map((item) => (
            <p key={item.created_at + item.text} className="small">{item.rating ? `${item.rating}/5. ` : ''}{item.text}</p>
          ))}
        </div>
      </section>
    </>
  );
}
