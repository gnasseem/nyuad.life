import { Fragment, useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Profile } from '../api';
import { INDEPENDENT } from '../brand';
import { IconArrow, IconBack } from '../icons';
import { ProfileForm } from './ProfileForm';
import { Wordmark } from './Logo';
import '../welcome.css';

type Line = 'ask' | 'plan' | 'questions' | 'guide';

interface Stop {
  line: Line;
  kicker: string;
  title: string;
  /** The line the stop draws across the screen behind its scene, in a 1000 × 500 box. */
  track: string;
  scene: ReactNode;
}

const STOPS: Stop[] = [
  { line: 'ask', kicker: 'Ask', title: 'Ask anything.', track: 'M -60 400 H 110 L 210 300 H 790 L 890 200 H 1060', scene: <AskScene /> },
  { line: 'plan', kicker: 'Plan', title: 'Plan a semester in one sentence.', track: 'M -60 130 H 130 L 230 230 H 770 L 870 330 H 1060', scene: <PlanScene /> },
  { line: 'guide', kicker: 'Reviews', title: 'Know a course before you take it.', track: 'M -60 370 H 140 L 230 280 H 770 L 860 370 H 1060', scene: <CoursesScene /> },
  { line: 'questions', kicker: 'Students', title: 'Help each other out.', track: 'M -60 140 H 150 L 240 230 H 760 L 850 140 H 1060', scene: <QuestionsScene /> },
];

/**
 * The first thing a new visitor sees: four full-screen stops, each one big moving picture of a section and a line of
 * large type, then email verification and account details, which everyone fills in before using the site. Someone who
 * has seen the tour but has no details (they removed them, or the server lost them) goes straight to the form.
 */
export function Welcome({ tour, reason, onToured, onDone }: { tour: boolean; reason?: string; onToured(): void; onDone(profile: Profile): void }) {
  const last = STOPS.length;
  const [canReturnToTour] = useState(tour);
  const [index, setIndex] = useState(tour ? 0 : last);
  const [direction, setDirection] = useState<1 | -1>(1);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

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
        const controls = Array.from(rootRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]') ?? []);
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
    rootRef.current?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
  }, [index, last]);

  const stop = STOPS[index];
  return createPortal(
    <div
      ref={rootRef}
      className={`welcome${stop ? '' : ' is-signup'}`}
      data-line={stop?.line ?? 'ask'}
      role="dialog"
      aria-modal="true"
      aria-labelledby="welcome-title"
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

      {stop ? (
        <div key={index} className={`welcome-stop ${direction > 0 ? 'from-right' : 'from-left'}`}>
          <div className="welcome-visual" aria-hidden="true">
            <span className="welcome-glow" />
            <Track d={stop.track} />
            <div className="welcome-scene">{stop.scene}</div>
          </div>
          <div className="welcome-copy">
            <span className="welcome-kicker">{stop.kicker}</span>
            <h2 id="welcome-title" tabIndex={-1}>
              {stop.title.split(' ').map((word, i) => (
                <Fragment key={i}>
                  {i > 0 && ' '}
                  <span style={{ '--w': i } as CSSProperties}>{word}</span>
                </Fragment>
              ))}
            </h2>
          </div>
        </div>
      ) : (
        <div className="welcome-signup-wrap">
          <div className="welcome-signup">
            <h2 id="welcome-title" tabIndex={-1}>Log in to nyuad.life</h2>
            <p>{reason || 'Use your NYU email to log in or create an account. It works on every device.'}</p>
            <ProfileForm onDone={onDone} submitLabel="Get started" steps />
            <p className="welcome-note">{INDEPENDENT}</p>
          </div>
        </div>
      )}

      <div className="welcome-foot">
        {index < last ? (
          <>
            <Progress index={index} onPick={go} />
            <div className="welcome-actions">
              <button type="button" className="welcome-back" onClick={() => go(index - 1)} disabled={index === 0} aria-label="Back">
                <IconBack />
              </button>
              <button type="button" className="welcome-next" onClick={() => go(index + 1)}>
                {index === last - 1 ? 'Log in' : 'Next'} <IconArrow />
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
    </div>,
    document.body,
  );
}

/** A bar per stop: the ones behind you filled, the one you are on filling in its line's colour. */
function Progress({ index, onPick }: { index: number; onPick(index: number): void }) {
  return (
    <div className="welcome-progress" role="group" aria-label="Tour">
      {STOPS.map((stop, i) => (
        <button key={stop.kicker} type="button" aria-current={i === index ? 'step' : undefined} aria-label={`${stop.kicker}, step ${i + 1} of ${STOPS.length}`} className={i < index ? 'done' : i === index ? 'now' : undefined} data-line={stop.line} onClick={() => onPick(i)} />
      ))}
    </div>
  );
}

/** The stop's line drawing itself across the screen, a station at each bend, and a train running along it. */
function Track({ d }: { d: string }) {
  const stations = Array.from(d.matchAll(/L (\d+) (\d+)/g), (match) => ({ x: match[1], y: match[2] }));
  return (
    <svg className="welcome-track" viewBox="0 0 1000 500" preserveAspectRatio="xMidYMid slice">
      <path className="wt-line" d={d} pathLength={1} />
      {stations.map((station, i) => (
        <circle key={i} className="wt-station" cx={station.x} cy={station.y} r="20" style={{ '--i': i } as CSSProperties} />
      ))}
      <rect className="wt-train" x="-34" y="-11" width="68" height="22" rx="11">
        <animateMotion path={d} dur="7s" begin="1.2s" repeatCount="indefinite" rotate="auto" />
      </rect>
    </svg>
  );
}

/* ---------- Scenes: a little of each section, moving, sized in em so they grow with the screen ---------- */

function AskScene() {
  return (
    <div className="scene-ask">
      <div className="sa-q">
        <span>Is Data Structures manageable with Calc 2?</span>
      </div>
      <div className="sa-answer">
        <div className="sa-route">
          {['Searching', 'Ranking', 'Writing'].map((label, i) => (
            <span key={label} style={{ '--i': i } as CSSProperties}>
              <i />
              {label}
            </span>
          ))}
        </div>
        <p style={{ '--i': 0 } as CSSProperties}>
          <b>Yes, if you start problem sets early.</b> <em>1</em>
        </p>
        <p style={{ '--i': 1 } as CSSProperties}>
          The midterm is the hard part. <em>2</em> <em>3</em>
        </p>
        <p className="bar" style={{ '--i': 2 } as CSSProperties} />
        <p className="bar short" style={{ '--i': 3 } as CSSProperties} />
        <div className="sa-sources">
          {[
            { label: 'Room of Requirement', line: 'questions' },
            { label: 'Albert', line: 'guide' },
            { label: 'nyuad.nyu.edu', line: 'notices' },
          ].map((source, i) => (
            <span key={source.label} data-line={source.line} style={{ '--i': i } as CSSProperties}>
              {source.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function PlanScene() {
  const blocks = [
    { day: 0, top: 8, height: 24, c: 0 },
    { day: 2, top: 8, height: 24, c: 0 },
    { day: 1, top: 38, height: 28, c: 1 },
    { day: 3, top: 38, height: 28, c: 1 },
    { day: 0, top: 62, height: 22, c: 2 },
    { day: 2, top: 62, height: 22, c: 2 },
    { day: 1, top: 6, height: 20, c: 3 },
    { day: 3, top: 74, height: 18, c: 4 },
  ];
  return (
    <div className="scene-plan">
      <div className="sp-ask">
        <span>Calc 2, Intro to CS, any Arts Core, Fridays off</span>
        <i />
      </div>
      <div className="sp-week">
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
      </div>
      <div className="sp-badge">
        <b>Plan 1</b> of 12 · top-rated professors
      </div>
    </div>
  );
}

function CoursesScene() {
  return (
    <div className="scene-courses">
      <div className="sc-top">
        <div className="sc-plate">
          <b>4.6</b>
          <span className="sc-stops">
            {[0, 1, 2, 3, 4].map((i) => (
              <i key={i} style={{ '--i': i, '--fill': i < 4 ? '100%' : '60%' } as CSSProperties} />
            ))}
          </span>
        </div>
        <div className="sc-side">
          <span className="sc-code">CS-UH 1050</span>
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
      <div className="sc-review">“Tough but fair. Go to office hours and you will be fine.”</div>
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
    </div>
  );
}
