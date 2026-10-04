import { describe, expect, it } from 'vitest';
import { abuDhabiDate, buildCatalog, courseRows, courseScheduleText, currentTerm, instructorScheduleText, liveTerms, matchSchedule, seatStatus, termOrder, type Offering } from './courses.ts';

function offering(term: string, code: string, title: string, instructors: string[], status = 'Open', dates = ['2026-08-24', '2026-12-14']): Offering {
  return {
    term,
    code,
    title,
    description: `${title} description.`,
    sections: [
      { classNumber: `${code}-${term}`, section: '001', component: 'Lecture', topic: '', units: '4', status, session: 'AD', startDate: dates[0]!, endDate: dates[1]!, grading: '', mode: 'In-Person', location: 'Abu Dhabi', instructors, meetings: [{ days: ['Tue', 'Thu'], startTime: '09:55', endTime: '11:10', room: 'A6 Room 001', startDate: dates[0]!, endDate: dates[1]! }], notes: '' },
    ],
    scraped: '2026-10-02T00:00:00.000Z',
  };
}

const rows = [
  offering('Fall 2026', 'CS-UH 1001', 'Introduction to Computer Science', ['Pötsch, Thomas']),
  offering('Spring 2026', 'CS-UH 1001', 'Introduction to Computer Science', ['Chaqfeh, Moumena'], 'Closed', ['2026-01-19', '2026-05-12']),
  offering('January 2027', 'CS-UH 1050', 'Data Structures', ['Young, Ana'], 'Wait List (3)', ['2027-01-05', '2027-01-15']),
  offering('Fall 2026', 'MATH-UH 1021', 'Multivariable Calculus', ['Rossi, Marco']),
  offering('Fall 2026', 'MATH-UH 1012', 'Calculus', ['Dania, Rana'], 'Cancelled'),
  offering('Fall 2026', 'CCEA-UH 1001X', 'Cities', ['Smith, Jo']),
];
const catalog = buildCatalog(rows, new Date('2026-10-04T08:00:00Z'));

describe('terms', () => {
  it('orders terms by the calendar', () => {
    expect(['Fall 2026', 'January 2026', 'Spring 2026', 'Summer 2026'].sort((a, b) => termOrder(a) - termOrder(b))).toEqual(['January 2026', 'Spring 2026', 'Summer 2026', 'Fall 2026']);
  });
  it('picks the term in session, else the next one', () => {
    expect(catalog.current).toBe('Fall 2026');
    expect(liveTerms(catalog)).toEqual(['Fall 2026', 'January 2027']);
    expect(currentTerm(catalog.terms, '2026-12-20')).toBe('January 2027');
  });
  it("uses Abu Dhabi's date, not UTC's", () => {
    expect(abuDhabiDate(new Date('2026-10-04T21:00:00Z'))).toBe('2026-10-05');
  });
});

describe('seat status', () => {
  it('reads Albert status strings', () => {
    expect(seatStatus('Open')).toEqual({ status: 'open' });
    expect(seatStatus('Wait List (4)')).toEqual({ status: 'waitlist', waitlist: 4 });
    expect(seatStatus('Cancelled')).toEqual({ status: 'cancelled' });
    expect(seatStatus('Closed')).toEqual({ status: 'closed' });
  });
});

describe('course rows', () => {
  it('lists one term with display names and core flags', () => {
    const list = courseRows(catalog, 'Fall 2026');
    expect(list.map((row) => row.code)).toEqual(['CCEA-UH 1001X', 'CS-UH 1001', 'MATH-UH 1012', 'MATH-UH 1021']);
    expect(list[0]!.core).toBe(true);
    expect(list[1]).toMatchObject({ subject: 'CS', credits: '4' });
    expect(list[1]!.sections[0]).toMatchObject({ instructors: ['Thomas Pötsch'], status: 'open', meetings: [{ days: ['Tue', 'Thu'], start: '09:55', end: '11:10', room: 'A6 Room 001' }] });
  });
});

describe('matching a question', () => {
  it('finds course codes in any spelling', () => {
    expect(matchSchedule(catalog, 'who teaches cs 1001?').courses).toEqual(['CS-UH 1001']);
    expect(matchSchedule(catalog, 'is CS1050 hard').courses).toEqual(['CS-UH 1050']);
    expect(matchSchedule(catalog, 'CCEA-UH 1001 reading load').courses).toEqual(['CCEA-UH 1001X']);
  });
  it('finds full titles, longest first, without the shorter title inside them', () => {
    expect(matchSchedule(catalog, 'Is Multivariable Calculus hard?').courses).toEqual(['MATH-UH 1021']);
    expect(matchSchedule(catalog, 'introduction to computer science or data structures first?').courses.sort()).toEqual(['CS-UH 1001', 'CS-UH 1050']);
  });
  it('finds professors by full name, or by surname next to a teaching word', () => {
    expect(matchSchedule(catalog, 'is professor potsch good').instructors).toEqual(['Thomas Pötsch']);
    expect(matchSchedule(catalog, 'Thomas Pötsch grading?').instructors).toEqual(['Thomas Pötsch']);
    expect(matchSchedule(catalog, 'what is pötsch like').instructors).toEqual([]);
    // "young" is an ordinary word, so a surname match alone does not count.
    expect(matchSchedule(catalog, 'which class is best for young students').instructors).toEqual([]);
  });
});

describe('schedule text for the answer model', () => {
  it('gives live terms in full and earlier terms as who taught them', () => {
    const text = courseScheduleText(catalog, 'CS-UH 1001');
    expect(text).toContain('Albert class schedule: CS-UH 1001 Introduction to Computer Science (4 credits)');
    expect(text).toContain('Fall 2026:\n- Lecture 001: Tue/Thu 09:55–11:10, A6 Room 001 · Thomas Pötsch · open');
    expect(text).toContain('Earlier terms: Spring 2026 (Moumena Chaqfeh).');
    expect(text).not.toContain('Not on the schedule');
  });
  it('says when every section is cancelled or the course is not running', () => {
    expect(courseScheduleText(catalog, 'MATH-UH 1012')).toContain('Fall 2026: every section cancelled');
    expect(courseScheduleText(buildCatalog([rows[1]!, rows[3]!], new Date('2026-10-04')), 'CS-UH 1001')).toContain('Not on the schedule for Fall 2026.');
  });
  it('lists what a professor teaches by term', () => {
    expect(instructorScheduleText(catalog, 'Thomas Pötsch')).toContain('Fall 2026: CS-UH 1001 Introduction to Computer Science (Lecture 001 Tue/Thu 09:55–11:10)');
  });
});
