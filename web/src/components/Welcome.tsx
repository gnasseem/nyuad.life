import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Profile } from '../api';
import { IconArrow, IconBack } from '../icons';
import { ProfileForm } from './ProfileForm';
import { Wordmark } from './Logo';
import '../welcome.css';

type Line = 'ask' | 'plan' | 'questions' | 'guide';

interface Stop {
  line: Line;
  kicker: string;
  title: string;
  text: string;
  points: string[];
  scene: ReactNode;
}

const STOPS: Stop[] = [
  {
    line: 'ask',
    kicker: 'Ask',
    title: 'Ask anything about NYUAD',
    text: 'Answers come from official NYUAD pages, the Albert schedule and thirteen years of Room of Requirement threads.',
    points: ['Every claim links to the thread or page it came from'],
    scene: <AskScene />,
  },
  {
    line: 'plan',
    kicker: 'Plan',
    title: 'Plan a semester in one sentence',
    text: '"Calc, intro to CS, any Arts Core, Fridays off." You get every week that fits, best-rated professors first.',
    points: ['Class numbers ready to paste into Albert'],
    scene: <PlanScene />,
  },
  {
    line: 'guide',
    kicker: 'Reviews',
    title: 'Know a course before you take it',
    text: 'Ratings written from what students said about every course and professor, plus reviews from students here.',
    points: ['Took a course? Rate it in ten seconds'],
    scene: <CoursesScene />,
  },
  {
    line: 'questions',
    kicker: 'Students',
    title: 'The rest comes from students like you',
    text: 'Ask what the archive cannot answer, answer what you know, find events, sell things and share rides.',
    points: ['Everyone here signs in with an NYU email'],
    scene: <QuestionsScene />,
  },
];

/**
 * The first thing a new visitor sees: four short screens on what the site does, then email verification and account details, which
 * everyone fills in before using the site. Someone who has seen the tour but has no details (they removed them, or
 * the server lost them) goes straight to the form.
 */
export function Welcome({ tour, reason, onToured, onDone }: { tour: boolean; reason?: string; onToured(): void; onDone(profile: Profile): void }) {
  const last = STOPS.length;
  const [canReturnToTour] = useState(tour);
  const [index, setIndex] = useState(tour ? 0 : last);
  const [direction, setDirection] = useState<1 | -1>(1);
  const touch = useRef<{ x: number; y: number } | null>(null);
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
      if (event.key === 'Tab') {
        const controls = Array.from(cardRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]') ?? []);
        const first = controls[0];
        const final = controls[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement?.tagName === 'H2')) {
          event.preventDefault();
          final?.focus();
        } else if (!event.shiftKey && document.activeElement === final) {
          event.preventDefault();
          first?.focus();
        }
        return;
      }
      if (index >= last || (event.target as HTMLElement | null)?.closest('input, select, textarea')) return;
      if (event.key === 'ArrowRight') { event.preventDefault(); go(index + 1); }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); go(index - 1); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [go, index, last]);

  // The page behind stays put and out of reach while this is open.
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const app = document.querySelector<HTMLElement>('.app');
    app?.setAttribute('inert', '');
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      app?.removeAttribute('inert');
      document.body.style.overflow = overflow;
      previousFocus?.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    cardRef.current?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
  }, [index, last]);

  const stop = STOPS[index];
  const line = stop?.line ?? 'ask';
  return createPortal(
    <div className="welcome" data-line={line} role="dialog" aria-modal="true" aria-labelledby="welcome-title">
      <div
        ref={cardRef}
        className={`welcome-card${stop ? '' : ' is-signup'}`}
        onPointerDown={(event) => {
          touch.current = event.pointerType === 'touch' && !(event.target as HTMLElement).closest('button, input, select, textarea') ? { x: event.clientX, y: event.clientY } : null;
        }}
        onPointerUp={(event) => {
          const start = touch.current;
          touch.current = null;
          if (!start || index >= last) return;
          const dx = event.clientX - start.x;
          const dy = event.clientY - start.y;
          if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) go(index + (dx < 0 ? 1 : -1));
        }}
        onPointerCancel={() => { touch.current = null; }}
      >
        <div className="welcome-head">
          <div className="welcome-brand"><Wordmark /></div>
          {stop && <button type="button" className="welcome-skip" onClick={() => go(last)}>Log in <IconArrow /></button>}
        </div>
        <div key={index} className={`welcome-page${stop ? '' : ' is-signup'} ${direction > 0 ? 'from-right' : 'from-left'}`}>
          {stop ? (
            <>
              <div className="welcome-visual">
                <div className="welcome-scene" aria-hidden="true">{stop.scene}</div>
                <span className="welcome-preview">Preview</span>
              </div>
              <div className="welcome-copy">
                <h2 id="welcome-title" tabIndex={-1}>{stop.title}</h2>
                <p>{stop.text}</p>
                <ul>
                  {stop.points.map((point) => (
                    <li key={point}>
                      {point}
                    </li>
                  ))}
                </ul>
              </div>
            </>
          ) : (
            <div className="welcome-signup">
              <h2 id="welcome-title" tabIndex={-1}>Log in to nyuad.life</h2>
              <p>{reason || 'Use your NYU email to log in or create an account.'}</p>
              <ProfileForm onDone={onDone} submitLabel="Get started" />
            </div>
          )}
        </div>

        <div className="welcome-foot">
          {index < last ? (
            <>
              <div className="welcome-position"><span>{stop?.kicker}</span><span>{index + 1} of {last}</span></div>
              <Progress index={index} total={last} onPick={go} />
              <div className="welcome-actions">
                <button type="button" className="btn ghost welcome-back" onClick={() => go(index - 1)} disabled={index === 0} aria-label="Back">
                  <IconBack />
                </button>
                <button type="button" className="btn primary welcome-next" onClick={() => go(index + 1)}>
                  {index === last - 1 ? 'Log in' : 'Next'} <IconArrow className="go" />
                </button>
              </div>
            </>
          ) : (
            canReturnToTour && (
              <button type="button" className="btn ghost sm" onClick={() => go(last - 1)}>
                <IconBack /> Back to the tour
              </button>
            )
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** The tour as a line with a stop per page; the train sits at the page you are on. */
function Progress({ index, total, onPick }: { index: number; total: number; onPick(index: number): void }) {
  return (
    <div className="welcome-progress" role="group" aria-label="Tour">
      <span className="welcome-track" aria-hidden="true" />
      <span className="welcome-train" aria-hidden="true" style={{ left: `calc(${(index / (total - 1)) * 100}% - 5px)` }} />
      {STOPS.map((stop, i) => (
        <button key={stop.kicker} type="button" aria-current={i === index ? 'step' : undefined} aria-label={`${stop.kicker}, step ${i + 1} of ${total}`} className={`welcome-dot${i <= index ? ' done' : ''}`} data-line={stop.line} style={{ left: `${(i / (total - 1)) * 100}%` }} onClick={() => onPick(i)} />
      ))}
    </div>
  );
}

/* ---------- Scenes: a little of each section, moving ---------- */

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
