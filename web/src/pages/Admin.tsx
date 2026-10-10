import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { api, type AdminDashboard, type ModelCheck, type UsageDayStats, type UsageReport, type UsageState } from '../api';
import { Flap } from '../components/Flap';
import { Segmented } from '../components/Segmented';
import { Sign } from '../components/Sign';
import { useApp } from '../context';
import { plural, relativeDate } from '../format';
import { IconRefresh, IconShield } from '../icons';

type Tab = 'usage' | 'members' | 'models' | 'moderation';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'usage', label: 'Usage' },
  { id: 'members', label: 'Members' },
  { id: 'models', label: 'Models' },
  { id: 'moderation', label: 'Moderation' },
];

/** What students did, in the order the page lists it. */
const EVENTS: Array<{ id: keyof UsageDayStats['events']; label: string }> = [
  { id: 'ask', label: 'Questions answered by Ask' },
  { id: 'ask_cached', label: 'Answered from the cache' },
  { id: 'ask_failed', label: 'Ask failed (every model down)' },
  { id: 'question', label: 'Questions asked to students' },
  { id: 'answer', label: 'Answers written by students' },
  { id: 'review', label: 'Course reviews written' },
  { id: 'plan', label: 'Plans read by the assistant' },
  { id: 'rating', label: 'Course ratings written' },
  { id: 'listing', label: 'Market listings' },
  { id: 'offer', label: 'Falcon and Campus Dirham offers' },
  { id: 'event', label: 'Events posted' },
  { id: 'login', label: 'Logins' },
  { id: 'signup', label: 'Sign-ups' },
];

const USAGE_LABEL: Record<UsageState, string> = {
  ok: 'Working',
  idle: 'Not used today',
  refused: 'Key refused',
  spent: "Today's quota used up",
  limited: 'Rate limited',
  gone: 'Model retired',
  overloaded: 'Overloaded',
  failing: 'Failing',
};

/** "Mon 6" from "2026-10-06", read as a calendar day. */
function dayLabel(day: string, style: 'short' | 'long' = 'short'): string {
  const date = new Date(`${day}T12:00:00Z`);
  return date.toLocaleDateString('en-GB', style === 'short' ? { weekday: 'short', day: 'numeric', timeZone: 'UTC' } : { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
}

function tabFromHash(): Tab {
  const hash = window.location.hash.slice(1) as Tab;
  return TABS.some((tab) => tab.id === hash) ? hash : 'usage';
}

/**
 * The control room for administrators: how many students use the site and what they do with it, what every model key
 * did today, and moderation. Everything here is read from /api/admin, which checks the allowlist on every request.
 */
export function AdminPage() {
  const { admin, profile } = useApp();
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [stats, setStats] = useState<AdminDashboard | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setStats(await api.admin.stats());
      setLoadedAt(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the numbers.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (admin) void load();
  }, [admin, load]);

  const pick = (next: Tab) => {
    setTab(next);
    window.history.replaceState(window.history.state, '', `/admin${next === 'usage' ? '' : `#${next}`}`);
  };

  if (!admin) {
    return (
      <div className="page admin-page">
        <Sign title="Admin" ar="الإدارة" />
        <div className="terminus">
          <div className="terminus-mark">
            <span className="terminus-ring">
              <IconShield />
            </span>
          </div>
          <h2>Administrators only</h2>
          <p>{profile ? 'Your verified NetID is not on the administrator list.' : 'Log in with a verified NYU email on the administrator list.'}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page admin-page">
      <Sign title="Admin" ar="الإدارة" sub="How nyuad.life is used today and over the last 30 days, what the answer models are doing, and moderation.">
        <button type="button" className="btn sm" onClick={() => void load()} disabled={loading}>
          <IconRefresh className={loading ? 'spin' : undefined} /> {loadedAt ? `Updated ${loadedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : 'Refresh'}
        </button>
      </Sign>
      {error && <div className="alert error">{error}</div>}
      <Board stats={stats} />
      <div className="tabs-wrap">
        <Segmented variant="tabs" label="Admin" value={tab} onChange={pick} options={TABS} />
      </div>
      <div className="tab-body" key={tab}>
        {tab === 'usage' && <UsageTab stats={stats} />}
        {tab === 'members' && <MembersTab stats={stats} />}
        {tab === 'models' && <ModelsTab />}
        {tab === 'moderation' && <ModerationTab stats={stats} />}
      </div>
    </div>
  );
}

/** Today's headline numbers on a departure board. */
function Board({ stats }: { stats: AdminDashboard | null }) {
  const today = stats?.days.at(-1);
  const week = stats?.days.slice(-7) ?? [];
  const sum = (days: UsageDayStats[], pick: (day: UsageDayStats) => number) => days.reduce((total, day) => total + pick(day), 0);
  const asks = (day?: UsageDayStats) => (day ? (day.events.ask ?? 0) + (day.events.ask_cached ?? 0) : 0);
  const cells = stats
    ? [
        { label: 'Members', value: stats.members.total, note: stats.members.today ? `+${stats.members.today} today` : `${plural(stats.members.week, 'new member')} this week` },
        { label: 'Active today', value: stats.active.today, note: `${stats.active.week.toLocaleString()} this week · ${stats.active.month.toLocaleString()} in 30 days` },
        { label: 'Sign-ups today', value: stats.members.today, note: `${stats.members.week.toLocaleString()} this week · ${stats.members.month.toLocaleString()} in 30 days` },
        { label: 'Requests today', value: today?.requests ?? 0, note: `${(today?.errors ?? 0).toLocaleString()} failed · ${(today?.avgMs ?? 0).toLocaleString()} ms average` },
        { label: 'Ask answers today', value: asks(today), note: `${sum(week, asks).toLocaleString()} this week · ${(today?.events.ask_failed ?? 0).toLocaleString()} failed today` },
      ]
    : [];
  return (
    <section className="ops-board" aria-label="Today" aria-busy={!stats}>
      {stats
        ? cells.map((cell) => (
            <div key={cell.label} className="ops-cell">
              <span className="ops-label">{cell.label}</span>
              <b className="ops-value">
                <Flap text={cell.value.toLocaleString()} />
              </b>
              <span className="ops-note">{cell.note}</span>
            </div>
          ))
        : Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="ops-cell">
              <span className="ops-label">&nbsp;</span>
              <b className="ops-value">–</b>
              <span className="ops-note">&nbsp;</span>
            </div>
          ))}
    </section>
  );
}

/** A single series of bars over days or hours, with the value of the bar under the pointer. */
function Bars({ values, labels, title, unit, tone, highlightLast = true }: { values: number[]; labels: string[]; title: string; unit: [string, string]; tone: string; highlightLast?: boolean }) {
  const [hot, setHot] = useState<number | null>(null);
  const max = Math.max(1, ...values);
  const width = 100 / values.length;
  const shown = hot ?? (highlightLast ? values.length - 1 : null);
  const total = values.reduce((sum, value) => sum + value, 0);
  return (
    <figure className="chart" style={{ '--tone': `var(--${tone})` } as CSSProperties}>
      <figcaption className="chart-head">
        <span className="chart-title">{title}</span>
        <span className="chart-reading" aria-live="polite">
          {shown === null ? (
            <>
              <b>{total.toLocaleString()}</b> in all
            </>
          ) : (
            <>
              <b>{values[shown]!.toLocaleString()}</b> {values[shown] === 1 ? unit[0] : unit[1]} · {labels[shown]}
            </>
          )}
        </span>
      </figcaption>
      <svg className="chart-plot" viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label={`${title}: ${values.map((value, i) => `${labels[i]} ${value}`).join(', ')}`} onPointerLeave={() => setHot(null)}>
        {[0.5, 1].map((line) => (
          <line key={line} className="chart-grid" x1="0" x2="100" y1={40 - line * 38} y2={40 - line * 38} vectorEffect="non-scaling-stroke" />
        ))}
        {values.map((value, i) => {
          const height = value ? Math.max(1.2, (value / max) * 38) : 0;
          return (
            <g key={i} onPointerEnter={() => setHot(i)}>
              <rect className="chart-hit" x={i * width} y="0" width={width} height="40" />
              <rect className={`chart-bar${i === shown ? ' on' : ''}`} x={i * width + width * 0.14} y={40 - height} width={width * 0.72} height={height} rx="0.6" />
            </g>
          );
        })}
      </svg>
      <div className="chart-axis" aria-hidden="true">
        <span>{labels[0]}</span>
        <span>{labels[Math.floor(labels.length / 2)]}</span>
        <span>{labels.at(-1)}</span>
      </div>
    </figure>
  );
}

function UsageTab({ stats }: { stats: AdminDashboard | null }) {
  const [table, setTable] = useState(false);
  if (!stats) return <Loading />;
  const days = stats.days;
  const labels = days.map((day) => dayLabel(day.day));
  const window = (count: number, id: keyof UsageDayStats['events']) => days.slice(-count).reduce((sum, day) => sum + (day.events[id] ?? 0), 0);
  const firstCounted = days.findIndex((day) => day.requests > 0);
  return (
    <div className="admin-stack">
      {!stats.shared && <div className="alert warn">The database could not be read: these counts come from one server instance only.</div>}
      <div className="chart-grid-3">
        <Bars title="Active members a day" values={days.map((day) => day.people)} labels={labels} unit={['member', 'members']} tone="teal" />
        <Bars title="Sign-ups a day" values={days.map((day) => day.signups)} labels={labels} unit={['sign-up', 'sign-ups']} tone="green" />
        <Bars title="Requests a day" values={days.map((day) => day.requests)} labels={labels} unit={['request', 'requests']} tone="cobalt" />
      </div>
      {firstCounted > 0 && <p className="faint small">Requests and active members are counted from {dayLabel(days[firstCounted]!.day, 'long')}; sign-ups go back to the first account.</p>}
      <button type="button" className="link-btn small" onClick={() => setTable((open) => !open)} aria-expanded={table}>
        {table ? 'Hide the numbers' : 'Show the numbers as a table'}
      </button>
      {table && (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Day</th>
                <th>Active</th>
                <th>Devices</th>
                <th>Sign-ups</th>
                <th>Requests</th>
                <th>Failed</th>
                <th>Ask answers</th>
              </tr>
            </thead>
            <tbody>
              {[...days].reverse().map((day) => (
                <tr key={day.day}>
                  <td>{dayLabel(day.day, 'long')}</td>
                  <td>{day.people}</td>
                  <td>{day.devices}</td>
                  <td>{day.signups}</td>
                  <td>{day.requests.toLocaleString()}</td>
                  <td>{day.errors}</td>
                  <td>{(day.events.ask ?? 0) + (day.events.ask_cached ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="admin-split">
        <section className="admin-block">
          <h2>Today by hour</h2>
          <Bars title="Requests, Abu Dhabi time" values={stats.hours} labels={stats.hours.map((_, hour) => `${String(hour).padStart(2, '0')}:00`)} unit={['request', 'requests']} tone="amber" highlightLast={false} />
        </section>
        <section className="admin-block">
          <h2>What students did</h2>
          <div className="table-wrap">
            <table className="data-table compact">
              <thead>
                <tr>
                  <th />
                  <th>Today</th>
                  <th>7 days</th>
                  <th>30 days</th>
                </tr>
              </thead>
              <tbody>
                {EVENTS.map((event) => (
                  <tr key={event.id}>
                    <td>{event.label}</td>
                    <td>{window(1, event.id)}</td>
                    <td>{window(7, event.id)}</td>
                    <td>{window(30, event.id)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <section className="admin-block">
        <h2>Busiest requests today</h2>
        {stats.routes.length === 0 ? (
          <p className="muted small">No requests counted yet today.</p>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Route</th>
                  <th>Requests</th>
                  <th>Average time</th>
                  <th>Failed</th>
                </tr>
              </thead>
              <tbody>
                {stats.routes.slice(0, 16).map((route) => (
                  <tr key={route.name}>
                    <td>
                      <code>{route.name}</code>
                    </td>
                    <td>{route.n.toLocaleString()}</td>
                    <td>
                      <span className={route.avgMs > 4000 ? 'slow' : undefined}>{route.avgMs < 1000 ? `${route.avgMs} ms` : `${(route.avgMs / 1000).toFixed(1)} s`}</span>
                    </td>
                    <td className={route.err ? 'bad' : undefined}>{route.err}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="admin-block">
        <h2>On the board now</h2>
        <dl className="count-grid">
          {[
            ['Questions', stats.board.questions],
            ['Waiting on an answer', stats.board.openQuestions],
            ['Student answers', stats.board.answers],
            ['Course reviews', stats.board.reviews],
            ['Open listings', stats.board.listings],
            ['Open offers', stats.board.offers],
            ['Upcoming events', stats.board.events],
            ['Barred accounts', stats.board.bans],
          ].map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{Number(value).toLocaleString()}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}

/** A labelled share bar, for the majors and years of the members. */
function Shares({ title, rows, total }: { title: string; rows: Array<{ name: string; n: number }>; total: number }) {
  return (
    <section className="admin-block">
      <h2>{title}</h2>
      <ul className="shares">
        {rows.map((row) => (
          <li key={row.name}>
            <span className="share-name">{row.name}</span>
            <span className="share-bar" aria-hidden="true">
              <i style={{ width: `${(row.n / Math.max(1, total)) * 100}%` }} />
            </span>
            <span className="share-n">{row.n}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function MembersTab({ stats }: { stats: AdminDashboard | null }) {
  const [query, setQuery] = useState('');
  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return (stats?.newest ?? []).filter((member) => words.every((word) => `${member.name} ${member.netId} ${member.major}`.toLowerCase().includes(word)));
  }, [stats, query]);
  if (!stats) return <Loading />;
  return (
    <div className="admin-stack">
      <section className="admin-block">
        <div className="admin-block-head">
          <h2>Newest members</h2>
          {stats.newest.length > 6 && <input className="input admin-filter" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter by name, NetID or major" aria-label="Filter members" />}
        </div>
        {stats.newest.length === 0 ? (
          <p className="muted small">Nobody has signed up yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>NetID</th>
                  <th>Major</th>
                  <th>Year</th>
                  <th>Joined</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((member) => (
                  <tr key={member.netId}>
                    <td>
                      <b>{member.name}</b>
                    </td>
                    <td>
                      <code>{member.netId}</code>
                    </td>
                    <td>{member.major}</td>
                    <td>{member.standing}</td>
                    <td title={new Date(member.createdAt).toLocaleString('en-GB')}>{relativeDate(member.createdAt)}</td>
                    <td title={new Date(member.lastSeenAt).toLocaleString('en-GB')}>{relativeDate(member.lastSeenAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <div className="admin-split">
        <Shares title="Majors" rows={stats.majors} total={stats.members.total} />
        <Shares title="Years" rows={stats.standings} total={stats.members.total} />
      </div>
    </div>
  );
}

/** "4 keys: 3 working, 1 refused." */
function usageSummary(usage: UsageReport): string {
  if (!usage.keys.length) return 'No model keys are set on the server.';
  const counts = new Map<UsageState, number>();
  for (const key of usage.keys) counts.set(key.state, (counts.get(key.state) ?? 0) + 1);
  return `${plural(usage.keys.length, 'key')}: ${[...counts].map(([state, n]) => `${n} ${USAGE_LABEL[state].toLowerCase()}`).join(', ')}. Counted since midnight in Abu Dhabi.`;
}

function callCounts(row: { ok: number; failed: number; remaining?: number | null; limit?: number | null }): string {
  const left = row.limit != null ? ` · ${(row.remaining ?? 0).toLocaleString()} of ${row.limit.toLocaleString()} left` : row.remaining != null ? ` · ${row.remaining.toLocaleString()} left` : '';
  return `${row.ok} ok · ${row.failed} failed${left}`;
}

function ModelsTab() {
  const { toast } = useApp();
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const [checks, setChecks] = useState<{ geminiKeyProblem: string | null; results: ModelCheck[] } | null>(null);
  const [busy, setBusy] = useState<'' | 'usage' | 'check' | 'warm' | 'email'>('');

  const run = async <T,>(what: typeof busy, work: () => Promise<T>, done: (result: T) => void) => {
    setBusy(what);
    try {
      done(await work());
    } catch (err) {
      toast(err instanceof Error ? err.message : 'That did not work.');
    } finally {
      setBusy('');
    }
  };
  const loadUsage = () => run('usage', api.admin.usage, setUsage);
  useEffect(() => {
    void loadUsage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const working = checks?.results.filter((result) => result.ok).length ?? 0;
  return (
    <div className="admin-stack">
      <section className="admin-block">
        <div className="admin-block-head">
          <h2>Model keys</h2>
          <button type="button" className="btn sm ghost" onClick={() => void loadUsage()} disabled={busy !== ''}>
            <IconRefresh className={busy === 'usage' ? 'spin' : undefined} /> Refresh
          </button>
        </div>
        <p className="muted small">{usage ? usageSummary(usage) : 'What each key did today: calls that worked, calls that failed and why, and what is left of its quota.'}</p>
        {usage && !usage.shared && <p className="faint small">The database could not be read: these counts are from one server instance only.</p>}
        {usage?.keys.map((key) => (
          <div key={`${key.key}-${key.hint}`} className="model-key">
            <div className={`model-check head ${key.state}`}>
              <span className="dot" />
              <b>{key.label}</b>
              <span className="hint">…{key.hint}</span>
              <span className="state">{USAGE_LABEL[key.state]}</span>
              <span className="ms">{callCounts(key)}</span>
              <span className="why">
                {key.state === 'refused' ? `${(key.models.find((model) => model.state === 'refused')?.lastError ?? 'The provider refused this key').replace(/\.?$/, '.')} Replace the key. ` : ''}
                Free tier: {key.freeTier}. This week: {key.week.ok} ok, {key.week.failed} failed.
              </span>
            </div>
            {key.state !== 'refused' &&
              key.models.map((model) => (
                <div key={model.model} className={`model-check sub ${model.state}`}>
                  <span className="dot" />
                  <b>{model.model}</b>
                  <span className="state">{USAGE_LABEL[model.state]}</span>
                  <span className="ms">{callCounts(model)}</span>
                  {model.state !== 'ok' && model.state !== 'idle' && model.lastError && (
                    <span className="why">
                      {model.lastErrorAt ? `${relativeDate(model.lastErrorAt)}: ` : ''}
                      {model.lastError}
                    </span>
                  )}
                </div>
              ))}
          </div>
        ))}
      </section>

      <section className="admin-block">
        <h2>Tools</h2>
        <div className="tool-list">
          <div className="tool">
            <div>
              <b>Check every model</b>
              <span>{checks ? `${working} of ${checks.results.length} answering right now.` : 'Sends one tiny request to every model and shows what each said: the quickest way to tell a wrong key from a spent quota.'}</span>
            </div>
            <button type="button" className="btn sm" onClick={() => void run('check', api.admin.models, setChecks)} disabled={busy !== ''}>
              {busy === 'check' ? <span className="spinner" /> : null} {busy === 'check' ? 'Checking' : 'Check models'}
            </button>
          </div>
          {checks && (
            <div className="model-checks">
              {checks.geminiKeyProblem && <div className="alert error">{checks.geminiKeyProblem}</div>}
              {checks.results.length === 0 && <p className="muted small">No model keys are set on the server.</p>}
              {checks.results.map((result) => (
                <div key={result.name} className={`model-check${result.ok ? ' ok' : ''}`}>
                  <span className="dot" />
                  <b>{result.name}</b>
                  <span className="ms">{(result.ms / 1000).toFixed(1)}s</span>
                  {result.error && <span className="why">{result.error}</span>}
                </div>
              ))}
            </div>
          )}
          <div className="tool">
            <div>
              <b>Write course ratings now</b>
              <span>Runs the nightly job: ratings for this term's most discussed courses and their professors that have none yet, for about half a minute. Run it again for more.</span>
            </div>
            <button
              type="button"
              className="btn sm"
              onClick={() => void run('warm', api.admin.warm, (result) => toast(`${plural(result.rated, 'rating')} written, ${result.none} with nothing to go on${result.failed ? `, ${result.failed} failed` : ''}. ${result.left} left.`))}
              disabled={busy !== ''}
            >
              {busy === 'warm' ? <span className="spinner" /> : null} {busy === 'warm' ? 'Writing' : 'Write ratings'}
            </button>
          </div>
          <div className="tool">
            <div>
              <b>Outage email</b>
              <span>
                {usage?.alerts.to.length
                  ? `Sent to ${usage.alerts.to.join(', ')} when every model fails a question, at most once every 3 hours. ${usage.alerts.last ? `Last sent ${relativeDate(usage.alerts.last.at)}.` : 'None sent yet.'}`
                  : "Sent to the administrators when every model fails a student's question."}
              </span>
            </div>
            <button type="button" className="btn sm ghost" onClick={() => void run('email', api.admin.alertTest, (result) => toast(`Test email sent to ${result.to.join(', ')}`))} disabled={busy !== ''}>
              {busy === 'email' ? <span className="spinner" /> : null} Send a test
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

const ACTION_LABEL: Record<string, string> = {
  remove_question: 'Removed a question',
  remove_answer: 'Removed an answer',
  remove_notice: 'Removed an event',
  remove_listing: 'Removed a listing',
  remove_offer: 'Removed an offer',
  remove_review: 'Removed a review',
  unban: 'Let post again',
};

function ModerationTab({ stats }: { stats: AdminDashboard | null }) {
  const { toast } = useApp();
  const [bans, setBans] = useState<Array<{ netId: string; reason: string; createdAt: string }> | null>(null);
  const [audit, setAudit] = useState<Array<{ action: string; target: string; createdAt: string }> | null>(null);
  useEffect(() => {
    api.admin
      .bans()
      .then((result) => setBans(result.bans))
      .catch(() => setBans([]));
    api.admin
      .audit()
      .then((result) => setAudit(result.audit))
      .catch(() => setAudit([]));
  }, []);
  const unban = async (netId: string) => {
    try {
      await api.admin.unban(netId);
      setBans((current) => current?.filter((ban) => ban.netId !== netId) ?? null);
      toast(`${netId} can post again`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not let them post again.');
    }
  };
  return (
    <div className="admin-stack">
      <p className="muted small">Every post on the site shows a dashed remove button while you are an administrator. Removing can also bar the writer.{stats ? ` ${plural(stats.board.bans, 'account is', 'accounts are')} barred.` : ''}</p>
      <section className="admin-block">
        <h2>Barred from posting</h2>
        {bans === null ? (
          <Loading />
        ) : bans.length === 0 ? (
          <p className="muted small">Nobody. “Remove and bar” on a post adds its writer here.</p>
        ) : (
          <div className="tool-list">
            {bans.map((ban) => (
              <div key={ban.netId} className="tool">
                <div>
                  <b>
                    <code>{ban.netId}</code>
                  </b>
                  <span>
                    {ban.reason || 'No reason given'} · {relativeDate(ban.createdAt)}
                  </span>
                </div>
                <button type="button" className="btn sm ghost" onClick={() => void unban(ban.netId)}>
                  Let post again
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
      <section className="admin-block">
        <h2>Recent admin actions</h2>
        {audit === null ? (
          <Loading />
        ) : audit.length === 0 ? (
          <p className="muted small">No removals yet.</p>
        ) : (
          <ul className="audit">
            {audit.map((entry, i) => (
              <li key={`${entry.createdAt}-${i}`}>
                <span>{ACTION_LABEL[entry.action] ?? ACTION_LABEL[entry.action.replace(/_and_ban$/, '')]?.concat(' and barred the writer') ?? entry.action}</span>
                <code>{entry.target.slice(0, 12)}</code>
                <time dateTime={entry.createdAt}>{relativeDate(entry.createdAt)}</time>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Loading() {
  return (
    <div className="stack" aria-busy="true">
      <div className="skeleton" style={{ height: 160 }} />
      <div className="skeleton" style={{ height: 120 }} />
    </div>
  );
}
