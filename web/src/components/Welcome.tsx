import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Profile } from '../api';
import { IconArrow, IconBack } from '../icons';
import { ProfileForm } from './ProfileForm';
import '../welcome.css';

type Line = 'ask' | 'plan' | 'questions' | 'notices' | 'market' | 'guide';

interface Stop {
  line: Line | 'central';
  kicker: string;
  title: string;
  text: string;
  points: string[];
  scene: ReactNode;
}

const STOPS: Stop[] = [
  {
    line: 'central',
    kicker: 'Welcome',
    title: 'Everything NYUAD students know, in one place',
    text: 'nyuad.life is built on thousands of threads from the Room of Requirement, the official NYUAD pages, the class schedule, and students like you.',
    points: ['Six lines, one map. Here is a quick ride through each.'],
    scene: <MapScene />,
  },
  {
    line: 'ask',
    kicker: 'Ask',
    title: 'Ask anything, get an answer with sources',
    text: 'Courses, professors, housing, visas, the best shawarma near campus.',
    points: ['Every answer cites the threads and pages it comes from', 'Follow-ups keep the context, and your chats stay in the list on the left'],
    scene: <AskScene />,
  },
  {
    line: 'plan',
    kicker: 'Plan',
    title: 'Plan a semester in one sentence',
    text: '"Calc, intro to CS, any Arts Core, nothing before 10, Fridays off."',
    points: ['Every timetable that fits, best-rated professors first', 'Class numbers ready to paste into Albert'],
    scene: <PlanScene />,
  },
  {
    line: 'questions',
    kicker: 'Questions',
    title: 'When the archive falls short, ask students',
    text: 'Questions go into a feed everyone sees, and students in the right major and year answer them.',
    points: ['Tap + to ask', 'Answer what you know and climb the helpers board'],
    scene: <QuestionsScene />,
  },
  {
    line: 'notices',
    kicker: 'Events',
    title: 'Never miss what is on',
    text: 'Campus gatherings from clubs and students, day by day.',
    points: ['Add anything to your calendar in one tap', 'Event details are screened before posting'],
    scene: <NoticesScene />,
  },
  {
    line: 'market',
    kicker: 'Market',
    title: 'Buy, sell, swap and share a ride',
    text: 'Things for sale, wanted or free, Falcon and Campus Dirham trades, rides off campus, and lost and found.',
    points: ['Contacts are shown one post at a time, only to students'],
    scene: <MarketScene />,
  },
  {
    line: 'guide',
    kicker: 'Courses',
    title: 'Know a course before you take it',
    text: 'Every course in Albert, searchable by code, title or professor.',
    points: ['Ratings written from what students actually said', 'Difficulty, workload, what they loved and what to watch out for'],
    scene: <CoursesScene />,
  },
];

/**
 * The first thing a new visitor sees: a short animated ride through each section, then email verification and account details, which
 * everyone fills in before using the site. Someone who has seen the tour but has no details (they removed them, or
 * the server lost them) goes straight to the form.
 */
export function Welcome({ tour, reason, onToured, onDone }: { tour: boolean; reason?: string; onToured(): void; onDone(profile: Profile): void }) {
  const last = STOPS.length;
  const [index, setIndex] = useState(tour ? 0 : last);
  const [direction, setDirection] = useState<1 | -1>(1);
  const touch = useRef<number | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const go = useCallback(
    (next: number) => {
      const target = Math.max(0, Math.min(last, next));
      setDirection(target >= index ? 1 : -1);
      setIndex(target);
      if (target === last) onToured();
    },
    [index, last, onToured],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (index >= last || (event.target as HTMLElement | null)?.closest('input, select, textarea')) return;
      if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select')) return;
      if (event.key === 'ArrowRight') go(index + 1);
      else if (event.key === 'ArrowLeft') go(index - 1);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [go, index, last]);

  // The page behind stays put and out of reach while this is open.
  useEffect(() => {
    const app = document.querySelector<HTMLElement>('.app');
    app?.setAttribute('inert', '');
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      app?.removeAttribute('inert');
      document.body.style.overflow = overflow;
    };
  }, []);

  useEffect(() => {
    cardRef.current?.querySelector<HTMLElement>(index === last ? '[data-autofocus]' : '.welcome-next')?.focus({ preventScroll: true });
  }, [index, last]);

  const stop = STOPS[index];
  const line = stop?.line ?? 'central';
  return createPortal(
    <div className="welcome" data-line={line === 'central' ? 'ask' : line} role="dialog" aria-modal="true" aria-label={stop ? stop.title : 'Log in'}>
      <div className="welcome-glow" aria-hidden="true" />
      <div
        ref={cardRef}
        className="welcome-card"
        onPointerDown={(event) => (touch.current = event.pointerType === 'touch' ? event.clientX : null)}
        onPointerUp={(event) => {
          if (touch.current === null || index >= last) return;
          const dx = event.clientX - touch.current;
          if (Math.abs(dx) > 50) go(index + (dx < 0 ? 1 : -1));
          touch.current = null;
        }}
      >
        <div key={index} className={`welcome-page ${direction > 0 ? 'from-right' : 'from-left'}`}>
          {stop ? (
            <>
              <div className="welcome-scene" aria-hidden="true">
                {stop.scene}
              </div>
              <div className="welcome-copy">
                <span className="welcome-kicker">
                  <i className="welcome-ring" />
                  {stop.kicker}
                </span>
                <h2>{stop.title}</h2>
                <p>{stop.text}</p>
                <ul>
                  {stop.points.map((point, i) => (
                    <li key={point} style={{ '--i': i } as CSSProperties}>
                      {point}
                    </li>
                  ))}
                </ul>
              </div>
            </>
          ) : (
            <div className="welcome-signup">
              <span className="welcome-kicker">
                <i className="welcome-ring" />
                Last stop
              </span>
              <h2>Log in to nyuad.life</h2>
              <p>{reason || 'Verify your NYU email to access your account from any device. New here? The same form creates your account.'}</p>
              <ProfileForm onDone={onDone} submitLabel="Get started" />
            </div>
          )}
        </div>

        <div className="welcome-foot">
          {index < last ? (
            <>
              <button type="button" className="btn ghost sm" onClick={() => go(index - 1)} disabled={index === 0} aria-label="Back">
                <IconBack />
              </button>
              <Progress index={index} total={last} onPick={go} />
              <button type="button" className="btn primary welcome-next" onClick={() => go(index + 1)}>
                {index === last - 1 ? 'Log in' : index === 0 ? 'Start the tour' : 'Next'} <IconArrow className="go" />
              </button>
            </>
          ) : (
            tour && (
              <button type="button" className="btn ghost sm" onClick={() => go(last - 1)}>
                <IconBack /> Back to the tour
              </button>
            )
          )}
        </div>
        {index < last && (
          <button type="button" className="welcome-skip" onClick={() => go(last)}>
            Log in or create an account
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** The tour as a line with a stop per page; the train sits at the page you are on. */
function Progress({ index, total, onPick }: { index: number; total: number; onPick(index: number): void }) {
  return (
    <div className="welcome-progress" role="tablist" aria-label="Tour">
      <span className="welcome-track" />
      <span className="welcome-train" style={{ left: `calc(${(index / (total - 1)) * 100}% - 9px)` }} />
      {STOPS.map((stop, i) => (
        <button key={stop.kicker} type="button" role="tab" aria-selected={i === index} aria-label={stop.kicker} className={`welcome-dot${i <= index ? ' done' : ''}`} data-line={stop.line === 'central' ? 'ask' : stop.line} style={{ left: `${(i / (total - 1)) * 100}%` }} onClick={() => onPick(i)} />
      ))}
    </div>
  );
}

/* ---------- Scenes: a little of each section, moving ---------- */

function MapScene() {
  const lines: Array<{ d: string; line: Line; delay: number }> = [
    { d: 'M -20 40 H 90 L 160 110', line: 'questions', delay: 0 },
    { d: 'M 340 30 H 240 L 160 110', line: 'notices', delay: 0.12 },
    { d: 'M -20 180 H 70 L 160 110', line: 'market', delay: 0.24 },
    { d: 'M 340 190 H 250 L 160 110', line: 'guide', delay: 0.36 },
    { d: 'M 160 -20 V 110', line: 'plan', delay: 0.48 },
    { d: 'M 160 240 V 110', line: 'ask', delay: 0.6 },
  ];
  return (
    <svg className="scene-map" viewBox="0 0 320 220">
      {lines.map((entry) => (
        <g key={entry.line} data-line={entry.line}>
          <path className="map-line" d={entry.d} pathLength={1} style={{ animationDelay: `${entry.delay}s` }} />
          <path className="map-train" d={entry.d} pathLength={1} style={{ animationDelay: `${1.2 + entry.delay}s` }} />
        </g>
      ))}
      <circle className="map-central" cx="160" cy="110" r="20" />
      <rect className="map-plate" x="118" y="141" width="84" height="20" rx="6" />
      <text className="map-label" x="160" y="156" textAnchor="middle">
        CENTRAL
      </text>
    </svg>
  );
}

function AskScene() {
  return (
    <div className="scene-ask">
      <div className="sa-q">
        <span>Is Data Structures manageable with Calc 2?</span>
      </div>
      <div className="sa-route">
        {['Searching', 'Ranking', 'Writing'].map((label, i) => (
          <span key={label} style={{ '--i': i } as CSSProperties}>
            <i />
            {label}
          </span>
        ))}
      </div>
      <div className="sa-answer">
        <p style={{ '--i': 0 } as CSSProperties}>
          <b>Yes, if you start problem sets early.</b> <em>1</em>
        </p>
        <p style={{ '--i': 1 } as CSSProperties}>
          The midterm is the hard part <em>2</em> <em>3</em>
        </p>
        <p className="short" style={{ '--i': 2 } as CSSProperties} />
      </div>
    </div>
  );
}

function PlanScene() {
  const blocks = [
    { day: 0, top: 10, height: 26, c: 0 },
    { day: 2, top: 10, height: 26, c: 0 },
    { day: 1, top: 40, height: 30, c: 1 },
    { day: 3, top: 40, height: 30, c: 1 },
    { day: 0, top: 58, height: 22, c: 2 },
    { day: 2, top: 58, height: 22, c: 2 },
    { day: 1, top: 6, height: 20, c: 3 },
  ];
  return (
    <div className="scene-plan">
      <div className="sp-head">
        {['M', 'T', 'W', 'Th', 'F'].map((day) => (
          <span key={day}>{day}</span>
        ))}
      </div>
      <div className="sp-grid">
        {blocks.map((block, i) => (
          <i key={i} style={{ left: `${block.day * 20 + 1}%`, top: `${block.top}%`, height: `${block.height}%`, '--c': `var(--plan-${block.c})`, '--i': i } as CSSProperties} />
        ))}
        <span className="sp-off">Friday off</span>
      </div>
      <div className="sp-badge">
        <b>Plan 1</b> of 12 · top-rated professors
      </div>
    </div>
  );
}

function QuestionsScene() {
  return (
    <div className="scene-questions">
      <div className="sq-card" style={{ '--i': 0 } as CSSProperties}>
        <b>Which dining hall is open latest on Fridays?</b>
        <span className="sq-answer">D2, until midnight. The Marketplace closes at 10.</span>
      </div>
      <div className="sq-card" style={{ '--i': 1 } as CSSProperties}>
        <b>Is the Abu Dhabi bus card worth it?</b>
        <span className="sq-pill">Needs an answer</span>
      </div>
      <span className="sq-plus">+</span>
    </div>
  );
}

function NoticesScene() {
  return (
    <div className="scene-notices">
      <div className="sn-week">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((day, i) => (
          <span key={i} style={{ '--i': i } as CSSProperties}>
            <em>{day}</em>
            <i className={i === 3 ? 'on' : ''} />
          </span>
        ))}
      </div>
      <div className="sn-card">
        <b>Thu 7:00pm</b>
        <span>Robotics club open night</span>
        <small>C2 Lab 012 · Add to calendar</small>
      </div>
    </div>
  );
}

function MarketScene() {
  return (
    <div className="scene-market">
      <div className="sm-tags">
        {[
          { what: 'Desk lamp', price: '40', unit: 'AED' },
          { what: 'Mini fridge', price: 'Free', unit: '' },
          { what: 'Falcons', price: '0.80', unit: 'AED' },
        ].map((tag, i) => (
          <div key={tag.what} className="sm-tag" style={{ '--i': i } as CSSProperties}>
            <span>{tag.what}</span>
            <b>
              {tag.price}
              {tag.unit && <small> {tag.unit}</small>}
            </b>
          </div>
        ))}
      </div>
      <div className="sm-board">
        <b>18:30</b>
        <span>Campus to Dubai Mall</span>
        <em>2 seats</em>
      </div>
    </div>
  );
}

function CoursesScene() {
  return (
    <div className="scene-courses">
      <div className="sc-plate">
        <b>4.6</b>
        <span className="sc-stops">
          {[0, 1, 2, 3, 4].map((i) => (
            <i key={i} style={{ '--i': i, '--fill': i < 4 ? '100%' : '60%' } as CSSProperties} />
          ))}
        </span>
      </div>
      <div className="sc-side">
        <span className="code">CS-UH 1050</span>
        <b>Data Structures</b>
        <div className="sc-meter">
          <em>Difficulty</em>
          <span>
            {[0, 1, 2, 3, 4].map((i) => (
              <i key={i} className={i < 4 ? 'on' : ''} style={{ '--i': i } as CSSProperties} />
            ))}
          </span>
        </div>
        <div className="sc-meter">
          <em>Workload</em>
          <span>
            {[0, 1, 2, 3, 4].map((i) => (
              <i key={i} className={i < 3 ? 'on' : ''} style={{ '--i': i + 5 } as CSSProperties} />
            ))}
          </span>
        </div>
      </div>
    </div>
  );
}
