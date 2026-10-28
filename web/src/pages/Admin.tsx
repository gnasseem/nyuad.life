import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { api, type AdminDashboard, type AskLogRow, type ModelCheck, type UsageDayStats, type UsageReport, type UsageState } from '../api';
import { Flap } from '../components/Flap';
import { Segmented } from '../components/Segmented';
import { Sign } from '../components/Sign';
import { useApp } from '../context';
import { plural, relativeDate } from '../format';
import { IconRefresh, IconShield } from '../icons';

type Tab = 'usage' | 'ask' | 'members' | 'data' | 'models' | 'moderation' | 'reports';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'usage', label: 'Usage' },
  { id: 'ask', label: 'Ask log' },
  { id: 'members', label: 'Members' },
  { id: 'data', label: 'Data sources' },
  { id: 'models', label: 'Models' },
  { id: 'moderation', label: 'Moderation' },
  { id: 'reports', label: 'Ask reports' },
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
  const [refresh, setRefresh] = useState(0);
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

  useEffect(() => {
    const sync = () => setTab(tabFromHash());
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

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
        <button type="button" className="btn sm" onClick={() => { void load(); setRefresh((value) => value + 1); }} disabled={loading}>
          <IconRefresh className={loading ? 'spin' : undefined} /> {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </Sign>
      {loadedAt && <p className="admin-updated muted small" role="status">Updated {loadedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Dubai' })} · Abu Dhabi time</p>}
      {error && <div className="alert error" role="alert">{error}</div>}
      <Board stats={stats} />
      <div className="tabs-wrap">
        <Segmented variant="tabs" label="Admin" value={tab} onChange={pick} options={TABS} />
      </div>
      <div className="tab-body" key={`${tab}-${refresh}`}>
        {tab === 'usage' && <UsageTab stats={stats} />}
        {tab === 'ask' && <AskLogTab />}
        {tab === 'members' && <MembersTab stats={stats} />}
        {tab === 'data' && <DataTab />}
        {tab === 'models' && <ModelsTab />}
        {tab === 'moderation' && <ModerationTab stats={stats} />}
        {tab === 'reports' && <ReportsTab />}
      </div>
    </div>
  );
}

/** Why an Ask question counts as not having worked, in the words the log shows; none means it worked. */
function askFlags(row: AskLogRow): string[] {
  const flags: string[] = [];
  const outcome = row.outcome ?? (row.missing ? 'missing' : 'answered');
  if (outcome === 'failed') flags.push('Failed');
  if (outcome === 'stopped') flags.push('Stopped');
  if (outcome === 'truncated') flags.push('Cut short');
  if (outcome === 'missing') flags.push('Not found');
  if (row.confidence === 'low' && outcome !== 'failed') flags.push('Low confidence');
  if (row.vote === 'down') flags.push('Thumbs down');
  if (row.asked) flags.push('Sent to students');
  if (row.reported) flags.push('Reported');
  return flags;
}

type AskFilter = 'all' | 'missed' | 'asked' | 'down' | 'failed' | 'worked';
const ASK_FILTERS: Array<{ id: AskFilter; label: string; test(row: AskLogRow, flags: string[]): boolean }> = [
  { id: 'missed', label: 'Did not work', test: (_, flags) => flags.length > 0 },
  { id: 'asked', label: 'Sent to students', test: (row) => Boolean(row.asked) },
  { id: 'down', label: 'Thumbs down', test: (row) => row.vote === 'down' },
  { id: 'failed', label: 'Failed', test: (row) => row.outcome === 'failed' || row.outcome === 'stopped' },
  { id: 'worked', label: 'Worked', test: (row, flags) => flags.length === 0 && row.outcome !== 'screened' && row.outcome !== 'redirect' },
  { id: 'all', label: 'All', test: () => true },
];
const OUTCOME_LABEL: Record<NonNullable<AskLogRow['outcome']>, string> = { answered: 'Answered', missing: 'Not found', truncated: 'Cut short', screened: 'Refused', redirect: 'Sent elsewhere', failed: 'Failed', stopped: 'Stopped' };

/**
 * Every Ask question of the last 90 days (newest 400), with how it went: what it was answered from, the confidence, the
 * student's thumbs, and whether they put it to students instead, which means Ask could not settle it.
 */
function AskLogTab() {
  const [rows, setRows] = useState<AskLogRow[] | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<AskFilter>('missed');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError('');
    try { setRows((await api.admin.askLog()).questions); }
    catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not load the Ask log.'); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const flagged = useMemo(() => (rows ?? []).map((row) => ({ row, flags: askFlags(row) })), [rows]);
  if (error) return <div className="alert error" role="alert">{error} <button type="button" className="btn sm" onClick={() => void load()}>Retry</button></div>;
  if (!rows) return <Loading />;

  const count = (id: AskFilter) => flagged.filter(({ row, flags }) => ASK_FILTERS.find((entry) => entry.id === id)!.test(row, flags)).length;
  const firsts = rows.map((row) => row.firstMs).filter((ms): ms is number => typeof ms === 'number' && ms > 0).sort((a, b) => a - b);
  const median = firsts.length ? firsts[Math.floor(firsts.length / 2)]! : 0;
  const worked = count('worked');
  const answered = rows.filter((row) => row.outcome !== 'screened' && row.outcome !== 'redirect').length;
  const needle = query.trim().toLowerCase();
  const test = ASK_FILTERS.find((entry) => entry.id === filter)!.test;
  const shown = flagged.filter(({ row, flags }) => test(row, flags) && (!needle || row.question.toLowerCase().includes(needle)));

  return (
    <div className="admin-stack">
      <div className="ask-tiles">
        <div><span>Questions</span><b>{rows.length.toLocaleString()}</b><small>since {relativeDate(rows[rows.length - 1]?.at ?? new Date().toISOString())}</small></div>
        <div className="tone-ok"><span>Worked</span><b>{answered ? Math.round((worked / answered) * 100) : 0}%</b><small>{plural(worked, 'answer')} with no flag</small></div>
        <div className="tone-alert"><span>Did not work</span><b>{count('missed')}</b><small>{count('failed')} failed outright</small></div>
        <div className="tone-line" data-line="notices"><span>Sent to students</span><b>{count('asked')}</b><small>Ask could not settle these</small></div>
        <div><span>Thumbs</span><b>{rows.filter((row) => row.vote === 'up').length} / {count('down')}</b><small>up / down</small></div>
        <div><span>First words</span><b>{median ? `${(median / 1000).toFixed(1)}s` : '—'}</b><small>median wait</small></div>
      </div>
      <section className="admin-block">
        <div className="admin-block-head">
          <div className="ask-filters" role="group" aria-label="Show">
            {ASK_FILTERS.map((entry) => (
              <button key={entry.id} type="button" className={`chip${filter === entry.id ? ' on' : ''}`} onClick={() => setFilter(entry.id)}>
                {entry.label} <span className="n">{count(entry.id)}</span>
              </button>
            ))}
          </div>
          <input className="input admin-filter" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a question" aria-label="Find a question" />
        </div>
        {shown.length === 0 && <p className="muted">Nothing here.</p>}
        <ol className="ask-log">
          {shown.slice(0, 300).map(({ row, flags }) => (
            <li key={row.id} className={flags.length ? 'flagged' : undefined}>
              <button type="button" className="ask-log-q" onClick={() => setOpen(open === row.id ? null : row.id)} aria-expanded={open === row.id}>
                <span className="ask-log-text">{row.followUp && <span className="faint">Follow-up · </span>}{row.question}</span>
                <span className="ask-log-meta">
                  {flags.map((flag) => <span key={flag} className={`pill ${flag === 'Sent to students' ? 'tone-line' : 'tone-alert'}`} data-line="notices">{flag}</span>)}
                  {!flags.length && <span className={`pill ${row.outcome === 'screened' || row.outcome === 'redirect' ? 'tone-slate' : 'tone-ok'}`}>{OUTCOME_LABEL[row.outcome ?? 'answered']}</span>}
                  {row.vote === 'up' && <span className="pill tone-ok">Thumbs up</span>}
                  {row.confidence && <span className="tag">{row.confidence}</span>}
                  {(row.sources ?? []).map((source) => <span key={source} className="tag">{source}</span>)}
                  {row.cached && <span className="tag">cached</span>}
                  <span className="faint small">{relativeDate(row.at)}{row.firstMs ? ` · ${(row.firstMs / 1000).toFixed(1)}s` : ''}{row.model ? ` · ${row.model}` : ''}</span>
                </span>
              </button>
              {open === row.id && <p className="ask-log-answer">{row.error ? `Error: ${row.error}` : row.answer || 'The answer was not kept for this question (asked before the log kept answers).'}</p>}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function ReportsTab() {
  const { toast } = useApp();
  const [reports, setReports] = useState<Awaited<ReturnType<typeof api.admin.askReports>>['reports'] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [resolved, setResolved] = useState(false);
  const load = useCallback(async () => {
    setError('');
    try { setReports((await api.admin.askReports()).reports); }
    catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not load reports.'); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const change = async (id: string, done: boolean) => {
    setBusy(id);
    try {
      await api.admin.resolveReport(id, done);
      setReports((rows) => rows?.map((row) => row.id === id ? { ...row, resolvedAt: done ? new Date().toISOString() : null } : row) ?? null);
      toast(done ? 'Report resolved' : 'Report reopened');
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not update this report.'); }
    finally { setBusy(''); }
  };
  const shown = reports?.filter((report) => Boolean(report.resolvedAt) === resolved);
  return <section className="admin-block">
    <div className="admin-block-head"><h2>Reported Ask answers</h2><button type="button" className="btn sm" onClick={() => setResolved(!resolved)}>{resolved ? 'Show open reports' : 'Show resolved reports'}</button></div>
    <p className="muted small">{reports ? `${reports.filter((report) => !report.resolvedAt).length} open · ${reports.filter((report) => report.resolvedAt).length} resolved` : 'Loading reports…'}</p>
    {error && <div className="alert error" role="alert">{error} <button type="button" className="btn sm" onClick={() => void load()}>Retry</button></div>}
    {shown?.length === 0 && <p className="muted">{resolved ? 'No resolved reports yet.' : 'No open reports. You’re caught up.'}</p>}
    {shown?.map((report) => <article key={report.id} className="report-example">
      <p className="faint small">Reported {relativeDate(report.createdAt)}{report.resolvedAt ? ` · Resolved ${relativeDate(report.resolvedAt)}` : ''}</p>
      <h3>{report.question}</h3>
      <p><strong>Reported issue:</strong> {report.reason}</p>
      <details><summary>Answer and sources</summary><p className="report-answer-text">{report.answer}</p>{report.sources?.filter((url) => /^https?:\/\//.test(url)).map((url) => <p key={url}><a href={url} target="_blank" rel="noopener noreferrer">{url}</a></p>)}</details>
      <button type="button" className="btn sm" disabled={busy !== ''} onClick={() => void change(report.id, !resolved)}>{busy === report.id ? 'Saving…' : resolved ? 'Reopen report' : 'Mark resolved'}</button>
    </article>)}
  </section>;
}

function DataTab() {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.admin.data>> | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setError('');
    try { setData(await api.admin.data()); }
    catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not load data sources.'); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const date = (value: string) => value ? new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Dubai' }) : 'Not available';
  return <div className="admin-stack">
    {error && <div className="alert error" role="alert">{error} <button type="button" className="btn sm" onClick={() => void load()}>Retry</button></div>}
    {!data && !error && <Loading />}
    {data && <>
      <section className="admin-block">
        <h2>What answers are based on</h2>
        <p className="muted small">The data currently served to students. A recent refresh can still contain older references; check both dates before relying on coverage.</p>
        <div className="data-sources">{data.sources.map((source) => <article className="data-source" key={source.name}>
          <div><h3>{source.name}</h3><p>{source.count.toLocaleString()} {source.unit}</p></div>
          <dl><div><dt>{source.name === 'Room of Requirement' ? 'Newest post' : 'Latest refresh'}</dt><dd>{date(source.updated)}</dd></div>
          {source.oldest && <div><dt>{source.name === 'Room of Requirement' ? 'Oldest post' : 'Oldest reference refresh'}</dt><dd>{date(source.oldest)}</dd></div>}
          {source.indexed && <div><dt>Search index built</dt><dd>{date(source.indexed)}</dd></div>}
          {source.semantic !== null && <div><dt>Search</dt><dd>{source.semantic ? 'Keyword + semantic index' : 'Keyword only'}</dd></div>}</dl>
          {source.problem ? <p className="alert error">{source.problem}</p> : source.count === 0 ? <p className="alert">No data loaded for this source.</p> : source.updated && Date.now() - Date.parse(source.updated) > 30 * 86_400_000 ? <p className="alert">No update in over 30 days. Refresh this source.</p> : null}
        </article>)}</div>
      </section>
      <div className="admin-split"><Shares title="Official reference topics" rows={data.sections} total={data.sections.reduce((n, row) => n + row.n, 0)} /><Shares title="Official source websites" rows={data.hosts} total={data.hosts.reduce((n, row) => n + row.n, 0)} /></div>
      <section className="admin-block"><h2>Albert coverage by term</h2><p className="muted small">Counts include all schools and study away sites in the imported schedule.</p>
        {data.terms.length === 0 ? <p className="muted">No terms have been imported.</p> : <div className="table-wrap" tabIndex={0} role="region" aria-label="Albert term coverage"><table className="data-table"><thead><tr><th>Term</th><th>Courses</th><th>Sections</th><th>Last refreshed</th></tr></thead><tbody>{data.terms.map((term) => <tr key={term.name}><td>{term.name}{term.current ? ' · Current' : ''}</td><td>{term.courses.toLocaleString()}</td><td>{term.sections.toLocaleString()}</td><td>{date(term.updated)}</td></tr>)}</tbody></table></div>}
      </section>
    </>}
  </div>;
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
  const [sort, setSort] = useState('joined');
  const [page, setPage] = useState(0);
  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return (stats?.directory ?? stats?.newest ?? []).filter((member) => words.every((word) => `${member.name} ${member.netId} ${member.major} ${member.classOf} ${member.standing}`.toLowerCase().includes(word))).sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : sort === 'answers' ? b.answers - a.answers : (sort === 'active' ? b.lastSeenAt.localeCompare(a.lastSeenAt) : b.createdAt.localeCompare(a.createdAt)));
  }, [stats, query, sort]);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(shown.length / 50) - 1));
  if (!stats) return <Loading />;
  return (
    <div className="admin-stack">
      <section className="admin-block">
        <div className="admin-block-head">
          <h2>Members · {stats.members.total.toLocaleString()}</h2>
          <div className="admin-controls"><input className="input admin-filter" type="search" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} placeholder="Name, NetID, major or year" aria-label="Filter members" />
          <select className="input admin-sort" aria-label="Sort members" value={sort} onChange={(event) => { setSort(event.target.value); setPage(0); }}><option value="joined">Newest members</option><option value="active">Recently active</option><option value="answers">Most answers</option><option value="name">Name A–Z</option></select></div>
        </div>
        {stats.members.total === 0 ? (
          <p className="muted small">Nobody has signed up yet.</p>
        ) : (
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Member directory">
            <table className="data-table member-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>NetID</th>
                  <th>Major</th>
                  <th>Year</th>
                  <th>Answers</th>
                  <th>Joined</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {shown.slice(currentPage * 50, (currentPage + 1) * 50).map((member) => (
                  <tr key={member.netId}>
                    <td>
                      <b>{member.name}</b>
                    </td>
                    <td>
                      <code>{member.netId}</code>
                    </td>
                    <td>{member.major}</td>
                    <td>{member.standing} · {member.classOf}</td>
                    <td>{member.answers}</td>
                    <td title={new Date(member.createdAt).toLocaleString('en-GB')}>{relativeDate(member.createdAt)}</td>
                    <td title={new Date(member.lastSeenAt).toLocaleString('en-GB')}>{relativeDate(member.lastSeenAt)}</td>
                  </tr>
                ))}
                {shown.length === 0 && <tr><td colSpan={7}>No members match “{query}”. Try a name, NetID, major or year.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
        {shown.length > 0 && <div className="admin-block-head"><p className="muted small" role="status">Showing {currentPage * 50 + 1}–{Math.min((currentPage + 1) * 50, shown.length)} of {shown.length} members</p>{shown.length > 50 && <div className="actions"><button type="button" className="btn sm" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button><button type="button" className="btn sm" disabled={(currentPage + 1) * 50 >= shown.length} onClick={() => setPage(currentPage + 1)}>Next</button></div>}</div>}
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
  const [busy, setBusy] = useState<'' | 'usage' | 'check' | 'email'>('');

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
  resolve_report: 'Resolved an Ask report',
  reopen_report: 'Reopened an Ask report',
};

function ModerationTab({ stats }: { stats: AdminDashboard | null }) {
  const { toast } = useApp();
  const [bans, setBans] = useState<Array<{ netId: string; reason: string; createdAt: string }> | null>(null);
  const [audit, setAudit] = useState<Array<{ action: string; target: string; createdAt: string }> | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const load = useCallback(() => {
    setError('');
    api.admin
      .bans()
      .then((result) => setBans(result.bans))
      .catch((problem) => setError(problem instanceof Error ? problem.message : 'Could not load barred accounts.'));
    api.admin
      .audit()
      .then((result) => setAudit(result.audit))
      .catch((problem) => setError(problem instanceof Error ? problem.message : 'Could not load admin actions.'));
  }, []);
  useEffect(load, [load]);
  const unban = async (netId: string) => {
    setBusy(netId);
    try {
      await api.admin.unban(netId);
      setBans((current) => current?.filter((ban) => ban.netId !== netId) ?? null);
      toast(`${netId} can post again`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not let them post again.');
    } finally { setBusy(''); }
  };
  return (
    <div className="admin-stack">
      {error && <div className="alert error" role="alert">{error} <button type="button" className="btn sm" onClick={load}>Retry</button></div>}
      <p className="muted small">Every post on the site shows a dashed remove button while you are an administrator. Removing can also bar the writer.{stats ? ` ${plural(stats.board.bans, 'account is', 'accounts are')} barred.` : ''}</p>
      <section className="admin-block">
        <h2>Barred from posting</h2>
        {bans === null ? (
          error ? null : <Loading />
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
                <button type="button" className="btn sm ghost" onClick={() => void unban(ban.netId)} disabled={busy !== ''}>
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
          error ? null : <Loading />
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
