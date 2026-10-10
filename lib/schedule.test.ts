import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildCatalog, courseRows, type Offering } from './courses.ts';
import { DEFAULT_RULES, highlights, lanes, minutes, normalizeRules, solve, waysToTake, type Quality, type Rules, type SolverCourse, type SolverSection } from './schedule.ts';

const TERM = { startDate: '2026-08-31', endDate: '2026-12-14' };

function section(classNumber: string, component: string, days: string[], start: string, end: string, extra: Partial<SolverSection> = {}): SolverSection {
  return { classNumber, section: '001', component, topic: '', status: 'open', instructors: ['Ana Lee'], meetings: [{ days, start, end }], ...TERM, ...extra };
}

function catalogOf(...courses: SolverCourse[]): Map<string, SolverCourse> {
  return new Map(courses.map((course) => [course.code, course]));
}

const rules = (patch: Partial<Rules> = {}): Rules => ({ ...DEFAULT_RULES, ...patch });
const quality = (profs: Record<string, number> = {}, courses: Record<string, number> = {}): Quality => ({ profs: new Map(Object.entries(profs)), courses: new Map(Object.entries(courses)) });
const want = (id: string, ...codes: string[]) => ({ id, codes });
const numbers = (result: ReturnType<typeof solve>, option = 0) => result.options[option]!.choices.map((choice) => choice.sections.map((s) => s.classNumber).join('+'));

describe('ways to take a course', () => {
  it('keeps only the requested seven-week halves, including 71 and 72 aliases', () => {
    const course: SolverCourse = { code: 'X-UH 1000', title: 'X', credits: '2', sections: [
      section('1', 'Seminar', ['Mon'], '10:00', '11:00', { session: '71' }),
      section('2', 'Seminar', ['Tue'], '10:00', '11:00', { session: 'A72' }),
      section('3', 'Seminar', ['Wed'], '10:00', '11:00', { session: 'AD' }),
    ] };
    expect(waysToTake(course, 'x', DEFAULT_RULES, ['71', '72']).ways.map((way) => way.sections[0]!.classNumber)).toEqual(['1', '2']);
    expect(waysToTake(course, 'x', DEFAULT_RULES, ['72']).ways.map((way) => way.sections[0]!.classNumber)).toEqual(['2']);
    expect(waysToTake(course, 'x', DEFAULT_RULES).ways).toHaveLength(3);
    const result = solve(catalogOf(course), [{ id: 'x', codes: [course.code], sessions: ['71', '72'] }], DEFAULT_RULES);
    expect(result.options.every((option) => option.choices[0]!.sections[0]!.classNumber !== '3')).toBe(true);
  });

  it('pairs a lecture with its own recitation when Albert numbers them alike', () => {
    const calc: SolverCourse = {
      code: 'MATH-UH 1012',
      title: 'Calculus',
      credits: '4',
      sections: [
        section('1', 'Lecture', ['Mon', 'Wed'], '08:30', '09:45', { section: '001' }),
        section('2', 'Lecture', ['Tue', 'Thu'], '08:30', '09:45', { section: '003' }),
        section('3', 'Recitation', ['Fri'], '10:00', '11:15', { section: 'REC1' }),
        section('4', 'Recitation', ['Fri'], '12:00', '13:15', { section: 'REC3' }),
      ],
    };
    const { ways } = waysToTake(calc, 'w', DEFAULT_RULES);
    expect(ways.map((way) => way.sections.map((s) => s.section))).toEqual([
      ['001', 'REC1'],
      ['003', 'REC3'],
    ]);
  });

  it('lets any lab go with any lecture when the numbers do not line up', () => {
    const engr: SolverCourse = {
      code: 'ENGR-UH 1000',
      title: 'Computer Programming',
      credits: '4',
      sections: [section('1', 'Lecture', ['Mon'], '09:55', '11:10'), section('2', 'Laboratory', ['Tue'], '14:00', '16:00', { section: 'LAB1' }), section('3', 'Laboratory', ['Wed'], '14:00', '16:00', { section: 'LAB2' })],
    };
    expect(waysToTake(engr, 'w', DEFAULT_RULES).ways).toHaveLength(2);
  });

  it('says which rule keeps a course out', () => {
    const morning: SolverCourse = { code: 'X-UH 1', title: 'X', credits: '4', sections: [section('1', 'Seminar', ['Mon', 'Wed'], '08:30', '09:45')] };
    expect(waysToTake(morning, 'w', rules({ earliest: '09:00' })).why).toBe('has every section starting before 9am');
    expect(waysToTake(morning, 'w', rules({ latest: '09:30' })).why).toBe('has every section ending after 9:30am');
    expect(waysToTake(morning, 'w', rules({ daysOff: ['Wed'] })).why).toBe('has every section on Wednesday, your day off');
    expect(waysToTake(morning, 'w', rules({ avoid: ['lee'] })).why).toBe('is only taught by Ana Lee, who you asked to avoid');
    const full: SolverCourse = { ...morning, sections: [section('1', 'Seminar', ['Mon'], '10:00', '11:00', { status: 'waitlist' })] };
    expect(waysToTake(full, 'w', DEFAULT_RULES).why).toBe('has no open seats');
    expect(waysToTake(full, 'w', rules({ waitlisted: true })).ways).toHaveLength(1);
    const lab: SolverCourse = { ...morning, sections: [section('1', 'Lecture', ['Mon'], '10:00', '11:00'), section('2', 'Laboratory', ['Fri'], '10:00', '12:00', { section: 'LAB' })] };
    expect(waysToTake(lab, 'w', rules({ daysOff: ['Fri'] })).why).toBe('has every laboratory on Friday, your day off');
    const mixed: SolverCourse = { ...morning, sections: [section('1', 'Seminar', ['Mon'], '10:00', '11:00'), section('2', 'Seminar', ['Tue'], '10:00', '11:00', { status: 'waitlist' }), section('3', 'Seminar', ['Wed'], '10:00', '11:00', { status: 'closed' })] };
    expect(waysToTake(mixed, 'w', rules({ daysOff: ['Mon'] })).why).toBe('has no section that fits: 2 are full; one meets on Monday, your day off');
    // A full section on a day off is out because of the day: freeing it is what would help.
    expect(waysToTake(mixed, 'w', rules({ daysOff: ['Mon', 'Tue', 'Wed'] })).why).toBe('has every section on Monday, Tuesday or Wednesday, your days off');
    const sameDay: SolverCourse = { ...morning, sections: [section('1', 'Lecture', ['Mon'], '10:00', '11:00'), section('2', 'Laboratory', ['Mon'], '14:00', '16:00', { section: 'LAB' })] };
    expect(waysToTake(sameDay, 'w', rules({ maxPerDay: 1 })).why).toBe('needs more than 1 class on one day');
  });
});

describe('solving a plan', () => {
  const a: SolverCourse = { code: 'A-UH 1', title: 'A', credits: '4', sections: [section('1', 'Seminar', ['Mon', 'Wed'], '09:55', '11:10'), section('2', 'Seminar', ['Tue', 'Thu'], '09:55', '11:10')] };
  const b: SolverCourse = { code: 'B-UH 1', title: 'B', credits: '4', sections: [section('3', 'Seminar', ['Mon', 'Wed'], '09:55', '11:10')] };
  const firstHalf: SolverCourse = { code: 'C-UH 1', title: 'C', credits: '2', sections: [section('4', 'Seminar', ['Mon', 'Wed'], '09:55', '11:10', { startDate: '2026-08-31', endDate: '2026-10-16' })] };
  const secondHalf: SolverCourse = { code: 'D-UH 1', title: 'D', credits: '2', sections: [section('5', 'Seminar', ['Mon', 'Wed'], '09:55', '11:10', { startDate: '2026-10-26', endDate: '2026-12-14' })] };

  it('finds the combinations that never clash, and moves a course to its other section', () => {
    const result = solve(catalogOf(a, b), [want('a', 'A-UH 1'), want('b', 'B-UH 1')], DEFAULT_RULES);
    expect(result.options).toHaveLength(1);
    expect(numbers(result)).toEqual(['2', '3']);
    expect(result.options[0]!.credits).toBe(8);
  });

  it('puts the two seven-week halves in the same slot', () => {
    const result = solve(catalogOf(firstHalf, secondHalf), [want('c', 'C-UH 1'), want('d', 'D-UH 1')], DEFAULT_RULES);
    expect(result.options).toHaveLength(1);
  });

  it('says which courses always clash, and what is not offered', () => {
    const clash = solve(catalogOf(b, firstHalf), [want('b', 'B-UH 1'), want('c', 'C-UH 1')], DEFAULT_RULES);
    expect(clash.problems).toEqual([{ want: 'c', text: 'B-UH 1 and C-UH 1 meet at the same time in every section, so only one fits.', fixes: [] }]);
    const missing = solve(catalogOf(a), [want('z', 'Z-UH 9')], DEFAULT_RULES);
    expect(missing.problems[0]!.text).toBe('Z-UH 9 is not offered this term.');
  });

  it('fills a slot with any one of several courses, never the same course twice', () => {
    const result = solve(catalogOf(a, b), [want('one', 'A-UH 1'), want('any', 'A-UH 1', 'B-UH 1')], DEFAULT_RULES);
    expect(result.options.every((option) => option.choices[1]!.code === 'B-UH 1')).toBe(true);
  });

  it('ranks by the soft preferences', () => {
    const early: SolverCourse = { code: 'E-UH 1', title: 'E', credits: '4', sections: [section('6', 'Seminar', ['Tue', 'Thu'], '12:45', '14:00', { instructors: ['Omar Haddad'] }), section('7', 'Seminar', ['Mon', 'Wed'], '12:45', '14:00', { instructors: ['Ana Lee'] })] };
    const compact = solve(catalogOf(b, early), [want('b', 'B-UH 1'), want('e', 'E-UH 1')], rules({ shape: 'compact' }));
    expect(compact.options[0]!.choices[1]!.sections[0]!.classNumber).toBe('7');
    expect(compact.options[0]!.days).toBe(2);
    const preferred = solve(catalogOf(b, early), [want('b', 'B-UH 1'), want('e', 'E-UH 1')], rules({ prefer: ['Haddad'] }));
    expect(preferred.options[0]!.choices[1]!.sections[0]!.classNumber).toBe('6');
  });

  it('prefers fewer gaps', () => {
    const f: SolverCourse = { code: 'F-UH 1', title: 'F', credits: '4', sections: [section('8', 'Seminar', ['Mon', 'Wed'], '14:10', '15:25'), section('9', 'Seminar', ['Mon', 'Wed'], '11:20', '12:35')] };
    expect(numbers(solve(catalogOf(b, f), [want('b', 'B-UH 1'), want('f', 'F-UH 1')], DEFAULT_RULES))).toEqual(['3', '9']);
  });
});

describe('ranking by ratings', () => {
  // Haddad teaches at 8:30, Lee an hour and a half later: an 8:30 twice a week is a small timing preference.
  const e: SolverCourse = { code: 'E-UH 1', title: 'E', credits: '4', sections: [section('6', 'Seminar', ['Tue', 'Thu'], '08:30', '09:45', { instructors: ['Omar Haddad'] }), section('7', 'Seminar', ['Tue', 'Thu'], '09:55', '11:10', { instructors: ['Ana Lee'] })] };
  const plan = (patch: Partial<Rules> = {}, q?: Quality) => solve(catalogOf(e), [want('e', 'E-UH 1')], rules(patch), q);

  it('lets a clearly better professor beat a small timing preference, but not a slightly better one', () => {
    expect(numbers(plan())).toEqual(['7']);
    expect(numbers(plan({}, quality({ 'Omar Haddad': 4.5 })))).toEqual(['6']);
    expect(numbers(plan({}, quality({ 'Omar Haddad': 4.5, 'Ana Lee': 4.2 })))).toEqual(['7']);
    expect(numbers(plan({}, quality({ 'Omar Haddad': 3.3 })))).toEqual(['7']);
  });

  it('never breaks a hard rule for a rating', () => {
    expect(numbers(plan({ earliest: '09:00' }, quality({ 'Omar Haddad': 5, 'Ana Lee': 1 })))).toEqual(['7']);
    expect(plan({ daysOff: ['Tue'] }, quality({ 'Omar Haddad': 5 })).options).toHaveLength(0);
  });

  it('treats professors no one rated as average, and ratings as off when the rule is', () => {
    expect(plan({}, quality()).options.map((option) => option.score)).toEqual(plan().options.map((option) => option.score));
    expect(numbers(plan({ bestRated: false }, quality({ 'Omar Haddad': 5 })))).toEqual(['7']);
  });

  it('weighs the lecturer more than whoever leads the recitation', () => {
    const lab: SolverCourse = {
      code: 'L-UH 1',
      title: 'L',
      credits: '4',
      sections: [
        section('1', 'Lecture', ['Mon'], '09:55', '11:10', { section: '001', instructors: ['Good Lecturer'] }),
        section('2', 'Lecture', ['Tue'], '09:55', '11:10', { section: '002', instructors: ['Plain Lecturer'] }),
        section('3', 'Recitation', ['Mon'], '14:10', '15:25', { section: 'REC1', instructors: ['Plain Leader'] }),
        section('4', 'Recitation', ['Tue'], '14:10', '15:25', { section: 'REC2', instructors: ['Great Leader'] }),
      ],
    };
    const result = solve(catalogOf(lab), [want('l', 'L-UH 1')], DEFAULT_RULES, quality({ 'Good Lecturer': 4.5, 'Great Leader': 5 }));
    expect(numbers(result)).toEqual(['1+3']);
  });

  it('picks the better-rated course when a slot has several', () => {
    const x: SolverCourse = { code: 'X-UH 1', title: 'X', credits: '4', sections: [section('1', 'Seminar', ['Mon', 'Wed'], '09:55', '11:10')] };
    const y: SolverCourse = { code: 'Y-UH 1', title: 'Y', credits: '4', sections: [section('2', 'Seminar', ['Mon', 'Wed'], '09:55', '11:10')] };
    const any = [want('any', 'X-UH 1', 'Y-UH 1')];
    expect(solve(catalogOf(x, y), any, DEFAULT_RULES, quality({}, { 'Y-UH 1': 4.6, 'X-UH 1': 3.1 })).options[0]!.choices[0]!.code).toBe('Y-UH 1');
    expect(solve(catalogOf(x, y), any, DEFAULT_RULES, quality({}, { 'X-UH 1': 4.6 })).options[0]!.choices[0]!.code).toBe('X-UH 1');
  });
});

describe('rules about the whole week', () => {
  const mon = (code: string, id: string, start: string, end: string, extra: Partial<SolverSection> = {}): SolverCourse => ({ code, title: code, credits: '4', sections: [section(id, 'Seminar', ['Mon'], start, end, extra)] });

  it('keeps to the most classes a day, and says how to loosen it', () => {
    const x = mon('X-UH 1', '1', '09:55', '11:10');
    const y: SolverCourse = { ...mon('Y-UH 1', '2', '14:10', '15:25'), sections: [section('2', 'Seminar', ['Mon'], '14:10', '15:25'), section('3', 'Seminar', ['Tue'], '14:10', '15:25')] };
    const wants = [want('x', 'X-UH 1'), want('y', 'Y-UH 1')];
    expect(numbers(solve(catalogOf(x, y), wants, rules({ maxPerDay: 1 })))).toEqual(['1', '3']);
    const z = mon('Z-UH 1', '4', '16:00', '17:00');
    const stuck = solve(catalogOf(x, z), [want('x', 'X-UH 1'), want('z', 'Z-UH 1')], rules({ maxPerDay: 1 }));
    expect(stuck.problems).toEqual([{ want: 'z', text: 'X-UH 1 and Z-UH 1 clash under your rules.', fixes: [{ label: 'Allow 2 classes a day', rules: { maxPerDay: 2 }, detail: undefined }] }]);
  });

  it('counts a first-half and a second-half class as one a day', () => {
    const first = mon('F-UH 1', '1', '09:55', '11:10', { startDate: '2026-08-31', endDate: '2026-10-16' });
    const second = mon('S-UH 1', '2', '14:10', '15:25', { startDate: '2026-10-26', endDate: '2026-12-14' });
    expect(solve(catalogOf(first, second), [want('f', 'F-UH 1'), want('s', 'S-UH 1')], rules({ maxPerDay: 1 })).options).toHaveLength(1);
  });

  it('leaves a break between classes when asked', () => {
    const x = mon('X-UH 1', '1', '09:55', '11:10');
    const y: SolverCourse = { ...mon('Y-UH 1', '2', '11:20', '12:35'), sections: [section('2', 'Seminar', ['Mon'], '11:20', '12:35'), section('3', 'Seminar', ['Mon'], '12:45', '14:00')] };
    const wants = [want('x', 'X-UH 1'), want('y', 'Y-UH 1')];
    expect(numbers(solve(catalogOf(x, y), wants, DEFAULT_RULES))).toEqual(['1', '2']);
    expect(numbers(solve(catalogOf(x, y), wants, rules({ noBackToBack: true })))).toEqual(['1', '3']);
    const tight = mon('T-UH 1', '4', '11:20', '12:35');
    expect(solve(catalogOf(x, tight), [want('x', 'X-UH 1'), want('t', 'T-UH 1')], rules({ noBackToBack: true })).problems[0]!.fixes.map((fix) => fix.label)).toEqual(['Allow back-to-back classes']);
  });
});

describe('when nothing fits', () => {
  it('names the rule in the way of one course, and the section loosening it lets in', () => {
    const calc: SolverCourse = { code: 'MATH-UH 1', title: 'Calc', credits: '4', sections: [section('1', 'Lecture', ['Mon', 'Wed'], '10:00', '11:15'), section('2', 'Recitation', ['Fri'], '10:00', '11:15', { section: 'REC' })] };
    const result = solve(catalogOf(calc), [want('c', 'MATH-UH 1')], rules({ daysOff: ['Fri'] }));
    expect(result.problems).toEqual([{ want: 'c', text: 'MATH-UH 1 has every recitation on Friday, your day off.', fixes: [{ label: 'Allow Friday classes', rules: { daysOff: [] }, detail: 'MATH-UH 1 Recitation REC (Fri 10am) meets on Friday' }] }]);
  });

  it('offers two changes together when no one change is enough', () => {
    // The Friday section is full as well, so freeing Friday alone would not do.
    const x: SolverCourse = { code: 'X-UH 1', title: 'X', credits: '4', sections: [section('1', 'Seminar', ['Fri'], '09:55', '11:10', { section: '002', status: 'waitlist' }), section('2', 'Seminar', ['Mon'], '08:30', '09:45')] };
    const result = solve(catalogOf(x), [want('x', 'X-UH 1')], rules({ daysOff: ['Fri'], earliest: '09:00' }));
    expect(result.problems[0]!.text).toBe('X-UH 1 has no section that fits: one meets on Friday, your day off; one starts before 9am.');
    expect(result.problems[0]!.fixes).toEqual([{ label: 'Allow classes before 9am', rules: { earliest: '' }, detail: 'X-UH 1 Seminar 001 (Mon 8:30am) starts at 8:30am' }]);
    const full = solve(catalogOf({ ...x, sections: [x.sections[0]!] }), [want('x', 'X-UH 1')], rules({ daysOff: ['Fri'] }));
    expect(full.problems[0]!.fixes.map((fix) => fix.label)).toEqual(['Include waitlists and allow Friday classes']);
  });

  it('says that another section of a named course would fit, and what it takes', () => {
    const a: SolverCourse = { code: 'A-UH 1', title: 'A', credits: '4', sections: [section('1', 'Seminar', ['Mon', 'Wed'], '09:55', '11:10'), section('2', 'Seminar', ['Tue', 'Thu'], '09:55', '11:10', { status: 'waitlist' })] };
    const b: SolverCourse = { code: 'B-UH 1', title: 'B', credits: '4', sections: [section('3', 'Seminar', ['Mon', 'Wed'], '09:55', '11:10')] };
    const result = solve(catalogOf(a, b), [want('a', 'A-UH 1'), want('b', 'B-UH 1')], DEFAULT_RULES);
    expect(result.problems).toEqual([{ want: 'b', text: 'A-UH 1 and B-UH 1 clash under your rules.', fixes: [{ label: 'Include waitlists', rules: { waitlisted: true }, detail: 'A-UH 1 Seminar 001 (Tue Thu 9:55am) is waitlisted' }] }]);
  });

  it('finds the courses that cannot all fit together when no two clash', () => {
    const two = (code: string, n: number): SolverCourse => ({ code, title: code, credits: '4', sections: [section(`${n}a`, 'Seminar', ['Mon', 'Wed'], '09:55', '11:10'), section(`${n}b`, 'Seminar', ['Tue', 'Thu'], '09:55', '11:10')] });
    const result = solve(catalogOf(two('A-UH 1', 1), two('B-UH 1', 2), two('C-UH 1', 3)), [want('a', 'A-UH 1'), want('b', 'B-UH 1'), { id: 'c', codes: ['C-UH 1'] }], DEFAULT_RULES);
    expect(result.problems).toEqual([{ want: '', text: 'A-UH 1, B-UH 1 and C-UH 1 cannot all fit together.', fixes: [{ label: 'Drop A-UH 1', drop: 'a' }, { label: 'Drop B-UH 1', drop: 'b' }] }]);
  });

  it('calls a slot of several courses by its name', () => {
    const x: SolverCourse = { code: 'X-UH 1', title: 'X', credits: '4', sections: [section('1', 'Seminar', ['Fri'], '09:55', '11:10')] };
    const result = solve(catalogOf(x), [{ id: 'core', codes: ['X-UH 1', 'Y-UH 1'], label: 'an Arts Core' }], rules({ daysOff: ['Fri'] }));
    expect(result.problems[0]!.text).toBe('No course for "an Arts Core" fits: X-UH 1 has every section on Friday, your day off; Y-UH 1 is not offered this term.');
  });
});

describe('saved rules', () => {
  it('loads an old plan with a lunch break, and fills in the new rules', () => {
    const old = { earliest: '10:00', latest: '', daysOff: ['Fri', 'Funday'], lunch: true, shape: 'compact', waitlisted: false, avoid: [], prefer: ['Pötsch'] };
    const loaded = normalizeRules(old);
    expect(loaded).toEqual({ ...DEFAULT_RULES, earliest: '10:00', daysOff: ['Fri'], shape: 'compact', prefer: ['Pötsch'] });
    expect('lunch' in loaded).toBe(false);
    expect(normalizeRules(null)).toEqual(DEFAULT_RULES);
    expect(normalizeRules({ maxPerDay: 9, bestRated: false }).maxPerDay).toBe(0);
  });
});

describe('a plan in a few words', () => {
  const x: SolverCourse = { code: 'X-UH 1', title: 'X', credits: '4', sections: [section('1', 'Seminar', ['Mon', 'Wed'], '10:00', '11:15', { instructors: ['Omar Haddad'] })] };
  const y: SolverCourse = { code: 'Y-UH 1', title: 'Y', credits: '4', sections: [section('2', 'Seminar', ['Mon', 'Wed'], '11:25', '12:40', { instructors: ['Ana Lee'] })] };

  it('leads with the professors, then the days and the hours', () => {
    const q = quality({ 'Omar Haddad': 4.6, 'Ana Lee': 4.3 });
    const option = solve(catalogOf(x, y), [want('x', 'X-UH 1'), want('y', 'Y-UH 1')], DEFAULT_RULES, q).options[0]!;
    expect(highlights(option, DEFAULT_RULES, q)).toEqual(['top-rated professors', '2 days on campus', 'nothing before 10am', 'no gaps']);
    expect(highlights(option, rules({ bestRated: false, daysOff: ['Tue'] }), q)).toEqual(['2 days on campus', 'Thursdays and Fridays free', 'nothing before 10am', 'no gaps']);
  });
});

describe('columns in the week grid', () => {
  it('gives a chain of overlaps two columns, not three', () => {
    // A overlaps B, B overlaps C, A and C do not meet.
    expect(lanes([{ start: 510, end: 660 }, { start: 595, end: 745 }, { start: 680, end: 800 }])).toEqual([
      { lane: 0, lanes: 2, span: 1 },
      { lane: 1, lanes: 2, span: 1 },
      { lane: 0, lanes: 2, span: 1 },
    ]);
  });

  it('keeps blocks that do not overlap full width, and splits three that all do', () => {
    expect(lanes([{ start: 600, end: 675 }, { start: 685, end: 760 }])).toEqual([
      { lane: 0, lanes: 1, span: 1 },
      { lane: 0, lanes: 1, span: 1 },
    ]);
    expect(lanes([{ start: 600, end: 700 }, { start: 610, end: 700 }, { start: 620, end: 700 }]).map((entry) => [entry.lane, entry.lanes])).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
    ]);
  });

  it('widens a block over columns nothing beside it uses', () => {
    const result = lanes([{ start: 0, end: 60 }, { start: 0, end: 20 }, { start: 0, end: 10 }, { start: 30, end: 60 }]);
    expect(result[3]).toEqual({ lane: 1, lanes: 3, span: 2 });
    expect(result[0]).toEqual({ lane: 0, lanes: 3, span: 1 });
  });
});

const CLASSES = 'data/classes.jsonl';

describe.skipIf(!existsSync(CLASSES))('the real Fall 2026 schedule', () => {
  const offerings = readFileSync(CLASSES, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Offering);
  const rows = courseRows(buildCatalog(offerings), 'Fall 2026');
  const catalog = new Map(rows.map((row) => [row.code, row as SolverCourse]));

  it('builds a first-year plan quickly, and no two classes in it meet at once', () => {
    const started = Date.now();
    const core = rows.filter((row) => row.code.startsWith('CADT-UH')).map((row) => row.code);
    const wants = [want('cs', 'CS-UH 1001'), want('calc', 'MATH-UH 1012'), { id: 'core', codes: core }];
    const result = solve(catalog, wants, rules({ waitlisted: true }));
    expect(Date.now() - started).toBeLessThan(3000);
    expect(result.options.length).toBeGreaterThan(0);
    for (const option of result.options) {
      expect(option.choices).toHaveLength(wants.length);
      const meetings = option.choices.flatMap((choice) => choice.sections.flatMap((s) => s.meetings.filter((m) => m.start).flatMap((m) => m.days.map((day) => ({ day, start: m.start, end: m.end, s })))));
      for (const x of meetings) for (const y of meetings) if (x !== y && x.s !== y.s && x.day === y.day && x.s.startDate <= y.s.endDate && y.s.startDate <= x.s.endDate) expect(x.start < y.end && y.start < x.end, `${x.s.classNumber} ${y.s.classNumber}`).toBe(false);
    }
    // Every Calculus recitation is on a Friday.
    expect(solve(catalog, wants, rules({ waitlisted: true, daysOff: ['Fri'] })).problems).toMatchObject([{ want: 'calc', text: 'MATH-UH 1012 has every recitation on Friday, your day off.', fixes: [{ label: 'Allow Friday classes', rules: { daysOff: [] } }] }]);
  });

  it('keeps to the week rules on a real plan', () => {
    const wants = [want('cs', 'CS-UH 1001'), want('calc', 'MATH-UH 1012'), want('econ', 'ECON-UH 1112')];
    const result = solve(catalog, wants, rules({ waitlisted: true, maxPerDay: 2, noBackToBack: true }));
    expect(result.options.length).toBeGreaterThan(0);
    for (const option of result.options) {
      const byDay = new Map<string, Array<[number, number, string]>>();
      for (const choice of option.choices) for (const s of choice.sections) for (const m of s.meetings) if (m.start) for (const day of m.days) byDay.set(day, [...(byDay.get(day) ?? []), [minutes(m.start), minutes(m.end), choice.code]]);
      for (const slots of byDay.values()) {
        expect(slots.length).toBeLessThanOrEqual(2);
        slots.sort((p, q) => p[0] - q[0]);
        for (let i = 1; i < slots.length; i++) if (slots[i]![2] !== slots[i - 1]![2]) expect(slots[i]![0] - slots[i - 1]![1]).toBeGreaterThanOrEqual(15);
      }
    }
  });
});
