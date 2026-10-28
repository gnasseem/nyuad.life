/**
 * The small cards that pop up in a corner (rate a course, review the site) share one budget so
 * they never pile up: none on a student's first visit, at most one a visit, none within a day of the last one, and each
 * kind with its own longer wait. Visits are counted per tab session in localStorage.
 */
export type NudgeKind = 'rate' | 'site';

const STATE_KEY = 'room.nudges';
const VISIT_KEY = 'room.visit';
const GAP_MS = 20 * 3_600_000;
const KIND_GAP_MS: Record<NudgeKind, number> = { rate: GAP_MS, site: 21 * 86_400_000 };

interface NudgeState {
  visits: number;
  last: number;
  kinds: Partial<Record<NudgeKind, { at: number; shown: number; until?: number }>>;
}

function load(): NudgeState {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (raw) return { visits: 0, last: 0, kinds: {}, ...(JSON.parse(raw) as Partial<NudgeState>) };
  } catch {
    // Private mode or a broken value: start over.
  }
  return { visits: 0, last: 0, kinds: {} };
}

function save(state: NudgeState): void {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    // Storage full or blocked: the cards just come back sooner.
  }
}

let claimedThisVisit = false;

/** This visit's number, counting it once per tab. */
export function visitCount(): number {
  const state = load();
  try {
    if (!sessionStorage.getItem(VISIT_KEY)) {
      sessionStorage.setItem(VISIT_KEY, '1');
      state.visits++;
      save(state);
    }
  } catch {
    // Without sessionStorage every load counts as a visit.
  }
  return state.visits;
}

/** Whether a card of this kind may show now, without taking the slot. */
export function mayNudge(kind: NudgeKind, now = Date.now()): boolean {
  if (claimedThisVisit || visitCount() < 2) return false;
  const state = load();
  const mine = state.kinds[kind];
  if (mine?.until && now < mine.until) return false;
  return now - state.last >= GAP_MS && (!mine || now - mine.at >= KIND_GAP_MS[kind]);
}

/** Takes this visit's one slot for a card about to show; false when another card got it first or the wait is not over. */
export function claimNudge(kind: NudgeKind, now = Date.now()): boolean {
  if (!mayNudge(kind, now) || document.querySelector('.modal-scrim')) return false;
  claimedThisVisit = true;
  const state = load();
  const mine = state.kinds[kind];
  state.last = now;
  state.kinds[kind] = { at: now, shown: (mine?.shown ?? 0) + 1 };
  save(state);
  return true;
}

/** How many times a card of this kind has shown. */
export function nudgeShown(kind: NudgeKind): number {
  return load().kinds[kind]?.shown ?? 0;
}

/** The student answered or turned this kind off: it stays away for `days`, or for good. */
export function finishNudge(kind: NudgeKind, days = Infinity): void {
  const state = load();
  const now = Date.now();
  state.kinds[kind] = { at: now, shown: state.kinds[kind]?.shown ?? 1, until: Number.isFinite(days) ? now + days * 86_400_000 : Number.MAX_SAFE_INTEGER };
  save(state);
}

/** Someone is typing in a box on the page: a card popping up now would be in the way. */
export function busyTyping(): boolean {
  const active = document.activeElement;
  return Boolean(active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || (active as HTMLElement).isContentEditable) && ((active as HTMLTextAreaElement).value ?? '').length > 0);
}
