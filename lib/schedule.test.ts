import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildCatalog, courseRows, type Offering } from './courses.ts';
import { DEFAULT_RULES, solve, waysToTake, type Rules, type SolverCourse, type SolverSection } from './schedule.ts';

const TERM = { startDate: '2026-08-31', endDate: '2026-12-14' };

function section(classNumber: string, component: string, days: string[], start: string, end: string, extra: Partial<SolverSection> = {}): SolverSection {
  return { classNumber, section: '001', component, topic: '', status: 'open', instructors: ['Ana Lee'], meetings: [{ days, start, end }], ...TERM, ...extra };
}

function catalogOf(...courses: SolverCourse[]): Map<string, SolverCourse> {
  return new Map(courses.map((course) => [course.code, course]));
}

const rules = (patch: Partial<Rules> = {}): Rules => ({ ...DEFAULT_RULES, ...patch });

describe('ways to take a course', () => {
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

  it('says why a course is out under the rules', () => {
    const morning: SolverCourse = { code: 'X-UH 1', title: 'X', credits: '4', sections: [section('1', 'Seminar', ['Mon', 'Wed'], '08:30', '09:45')] };
    expect(waysToTake(morning, 'w', rules({ earliest: '09:00' })).why).toBe('has no section in your hours');
    expect(waysToTake(morning, 'w', rules({ daysOff: ['Wed'] })).why).toBe('only meets on your days off');
    expect(waysToTake(morning, 'w', rules({ avoid: ['lee'] })).why).toBe('is only taught by a professor you asked to avoid');
    const full: SolverCourse = { ...morning, sections: [section('1', 'Seminar', ['Mon'], '10:00', '11:00', { status: 'waitlist' })] };
    expect(waysToTake(full, 'w', DEFAULT_RULES).why).toBe('has no open seats');
    expect(waysToTake(full, 'w', rules({ waitlisted: true })).ways).toHaveLength(1);
    const lab: SolverCourse = { ...morning, sections: [section('1', 'Lecture', ['Mon'], '10:00', '11:00'), section('2', 'Laboratory', ['Fri'], '10:00', '12:00', { section: 'LAB' })] };
    expect(waysToTake(lab, 'w', rules({ daysOff: ['Fri'] })).why).toBe('only has a laboratory on your days off');
  });
});

describe('solving a plan', () => {
  const a: SolverCourse = { code: 'A-UH 1', title: 'A', credits: '4', sections: [section('1', 'Seminar', ['Mon', 'Wed'], '09:55', '11:10'), section('2', 'Seminar', ['Tue', 'Thu'], '09:55', '11:10')] };
  const b: SolverCourse = { code: 'B-UH 1', title: 'B', credits: '4', sections: [section('3', 'Seminar', ['Mon', 'Wed'], '09:55', '11:10')] };
  const firstHalf: SolverCourse = { code: 'C-UH 1', title: 'C', credits: '2', sections: [section('4', 'Seminar', ['Mon', 'Wed'], '09:55', '11:10', { startDate: '2026-08-31', endDate: '2026-10-16' })] };
  const secondHalf: SolverCourse = { code: 'D-UH 1', title: 'D', credits: '2', sections: [section('5', 'Seminar', ['Mon', 'Wed'], '09:55', '11:10', { startDate: '2026-10-26', endDate: '2026-12-14' })] };

  it('finds the combinations that never clash, and moves a course to its other section', () => {
    const result = solve(catalogOf(a, b), [{ id: 'a', codes: ['A-UH 1'] }, { id: 'b', codes: ['B-UH 1'] }], DEFAULT_RULES);
    expect(result.options).toHaveLength(1);
    expect(result.options[0]!.choices.map((choice) => choice.sections[0]!.classNumber)).toEqual(['2', '3']);
    expect(result.options[0]!.credits).toBe(8);
  });

  it('puts the two seven-week halves in the same slot', () => {
    const result = solve(catalogOf(firstHalf, secondHalf), [{ id: 'c', codes: ['C-UH 1'] }, { id: 'd', codes: ['D-UH 1'] }], DEFAULT_RULES);
    expect(result.options).toHaveLength(1);
  });

  it('says which courses always clash, and what is not offered', () => {
    const clash = solve(catalogOf(b, firstHalf), [{ id: 'b', codes: ['B-UH 1'] }, { id: 'c', codes: ['C-UH 1'] }], DEFAULT_RULES);
    expect(clash.problems).toEqual([{ want: 'c', text: 'B-UH 1 and C-UH 1 always clash.' }]);
    const missing = solve(catalogOf(a), [{ id: 'z', codes: ['Z-UH 9'] }], DEFAULT_RULES);
    expect(missing.problems[0]!.text).toBe('Z-UH 9 is not offered this term.');
  });

  it('fills a slot with any one of several courses, never the same course twice', () => {
    const result = solve(catalogOf(a, b), [{ id: 'one', codes: ['A-UH 1'] }, { id: 'any', codes: ['A-UH 1', 'B-UH 1'] }], DEFAULT_RULES);
    expect(result.options.every((option) => option.choices[1]!.code === 'B-UH 1')).toBe(true);
  });

  it('ranks by the soft preferences', () => {
    const early: SolverCourse = { code: 'E-UH 1', title: 'E', credits: '4', sections: [section('6', 'Seminar', ['Tue', 'Thu'], '12:45', '14:00', { instructors: ['Omar Haddad'] }), section('7', 'Seminar', ['Mon', 'Wed'], '12:45', '14:00', { instructors: ['Ana Lee'] })] };
    const compact = solve(catalogOf(b, early), [{ id: 'b', codes: ['B-UH 1'] }, { id: 'e', codes: ['E-UH 1'] }], rules({ shape: 'compact' }));
    expect(compact.options[0]!.choices[1]!.sections[0]!.classNumber).toBe('7');
    expect(compact.options[0]!.days).toBe(2);
    const preferred = solve(catalogOf(b, early), [{ id: 'b', codes: ['B-UH 1'] }, { id: 'e', codes: ['E-UH 1'] }], rules({ prefer: ['Haddad'] }));
    expect(preferred.options[0]!.choices[1]!.sections[0]!.classNumber).toBe('6');
    const lunch = solve(catalogOf(b, early), [{ id: 'b', codes: ['B-UH 1'] }, { id: 'e', codes: ['E-UH 1'] }], rules({ lunch: true, shape: 'compact' }));
    expect(lunch.options[0]!.score).toBeLessThan(lunch.options[1]!.score);
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
    const wants = [{ id: 'cs', codes: ['CS-UH 1001'] }, { id: 'calc', codes: ['MATH-UH 1012'] }, { id: 'core', codes: core }];
    const result = solve(catalog, wants, rules({ waitlisted: true }));
    expect(Date.now() - started).toBeLessThan(3000);
    expect(result.options.length).toBeGreaterThan(0);
    for (const option of result.options) {
      expect(option.choices).toHaveLength(wants.length);
      const meetings = option.choices.flatMap((choice) => choice.sections.flatMap((s) => s.meetings.filter((m) => m.start).flatMap((m) => m.days.map((day) => ({ day, start: m.start, end: m.end, s })))));
      for (const x of meetings) for (const y of meetings) if (x !== y && x.s !== y.s && x.day === y.day && x.s.startDate <= y.s.endDate && y.s.startDate <= x.s.endDate) expect(x.start < y.end && y.start < x.end, `${x.s.classNumber} ${y.s.classNumber}`).toBe(false);
    }
    // Every Calculus recitation is on a Friday.
    expect(solve(catalog, wants, rules({ waitlisted: true, daysOff: ['Fri'] })).problems).toEqual([{ want: 'calc', text: 'MATH-UH 1012 only has a recitation on your days off.' }]);
  });
});
