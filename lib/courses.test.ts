import { describe, expect, it } from 'vitest';
import { abuDhabiDate, allCourses, buildCatalog, courseRows, courseScheduleText, currentTerm, instructorScheduleText, liveTerms, matchSchedule, seatStatus, termOrder, type Offering } from './courses.ts';
import { schoolRows } from './plan-school.ts';
import { planSchools } from './plan-schools.ts';

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
  offering('Fall 2026', 'ENGR-UH 4010', 'Capstone Project', ['Ali, Omar']),
  offering('Fall 2026', 'PHYS-UH 4010', 'Capstone Project', ['Chen, Li']),
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
  it('does not duplicate a class returned by two teaching schools', () => {
    const cas = offering('Fall 2026', 'MATH-UA 101', 'Calculus I', ['Lee, Ana']);
    cas.school = 'College of Arts and Science';
    cas.sections[0]!.location = 'Washington Square';
    const crossListed = { ...cas, school: 'Liberal Studies', sections: cas.sections.map((section) => ({ ...section, school: 'Liberal Studies' })) };
    expect(schoolRows(buildCatalog([cas, crossListed]), 'Fall 2026', 'New York')[0]!.sections).toHaveLength(1);
  });

  it('keeps graduate-only Saturday classes out of the undergraduate Abu Dhabi planner', () => {
    const undergrad = offering('Fall 2026', 'ECON-UH 1010', 'Economics', ['Lee, Ana']);
    const graduate = offering('Fall 2026', 'ECON-GH 5100', 'Graduate Economics', ['Lee, Ana']);
    graduate.sections[0]!.meetings[0]!.days = ['Sat'];
    const catalog = buildCatalog([undergrad, graduate]);
    expect(schoolRows(catalog, 'Fall 2026', 'Abu Dhabi').map((row) => row.code)).toEqual(['ECON-UH 1010']);
    expect(schoolRows(catalog, 'Fall 2026', 'Abu Dhabi graduate').map((row) => row.code)).toEqual(['ECON-GH 5100']);
    expect(planSchools(catalog)).toContainEqual({ id: 'Abu Dhabi graduate', label: 'Abu Dhabi · graduate classes', group: 'School' });
  });

  it('keeps only sections taught at the selected site', () => {
    const mixed = offering('Fall 2026', 'CS-UH 1052G', 'Algorithms', ['Lee, Ana']);
    mixed.sections.push({ ...mixed.sections[0]!, classNumber: 'paris-1', location: 'NYU Paris (Global)', instructors: ['Martin, Eve'] });
    const cso = offering('Fall 2026', 'CS-UH 2010G', 'Computer Systems Organization', ['Martin, Eve']);
    cso.sections[0]!.location = 'NYU Paris (Global)';
    const cas = offering('Fall 2026', 'MATH-UA 101', 'Calculus I', ['Diaz, Sol']);
    cas.sections[0]!.location = 'NYU New York';
    const source = buildCatalog([mixed, cso, cas]);
    expect(schoolRows(source, 'Fall 2026', 'Abu Dhabi')[0]!.sections.map((section) => section.classNumber)).toEqual([mixed.sections[0]!.classNumber]);
    expect(schoolRows(source, 'Fall 2026', 'NYU Paris (Global)').map((row) => row.code)).toEqual(['CS-UH 1052G', 'CS-UH 2010G']);
    expect(schoolRows(source, 'Fall 2026', 'CAS').map((row) => row.code)).toEqual(['MATH-UA 101']);
  });

  it('combines the same course from separate school scrapes without mixing their sections', () => {
    const home = offering('Fall 2026', 'CS-UH 1052G', 'Algorithms', ['Lee, Ana']);
    const away = offering('Fall 2026', 'CS-UH 1052G', 'Algorithms', ['Martin, Eve']);
    away.school = 'NYU Paris';
    away.sections[0]!.school = 'NYU Paris';
    away.sections[0]!.location = 'NYU Paris (Global)';
    away.sections[0]!.classNumber = 'paris-2';
    const source = buildCatalog([home, away]);
    expect(schoolRows(source, 'Fall 2026', 'Abu Dhabi')[0]!.sections).toHaveLength(1);
    expect(schoolRows(source, 'Fall 2026', 'NYU Paris (Global)')[0]!.sections.map((section) => section.classNumber)).toEqual(['paris-2']);
  });
  it('lists every scraped school and keeps study away sections out of home school results', () => {
    const home = offering('Fall 2026', 'MATH-UA 101', 'Calculus', ['Diaz, Sol']);
    home.school = 'College of Arts and Science';
    home.sections[0]!.school = home.school;
    home.sections[0]!.location = 'New York';
    const away = offering('Fall 2026', 'MATH-UA 101', 'Calculus', ['Diaz, Sol']);
    away.school = home.school;
    away.sections[0]!.school = home.school;
    away.sections[0]!.location = 'NYU London (Global)';
    away.sections[0]!.classNumber = 'london-1';
    const stern = offering('Fall 2026', 'FINC-UB 1001', 'Finance', ['Lee, Ana']);
    stern.school = 'Leonard N. Stern School of Business';
    stern.sections[0]!.school = stern.school;
    stern.sections[0]!.location = 'New York';
    const source = buildCatalog([home, away, stern]);
    expect(planSchools(source).map((school) => school.id)).toContain(stern.school);
    expect(planSchools(source).map((school) => school.id)).toContain('New York');
    expect(planSchools(source).map((school) => school.id)).toContain('NYU London (Global)');
    expect(schoolRows(source, 'Fall 2026', 'CAS')[0]!.sections).toHaveLength(1);
    expect(schoolRows(source, 'Fall 2026', 'New York').map((row) => row.code)).toEqual(['FINC-UB 1001', 'MATH-UA 101']);
    expect(schoolRows(source, 'Fall 2026', 'NYU London (Global)')[0]!.sections[0]!.classNumber).toBe('london-1');
    expect(schoolRows(source, 'Fall 2026', stern.school)[0]!.code).toBe('FINC-UB 1001');
  });
  it('labels both raw and prefixed seven-week session codes', () => {
    for (const session of ['71', 'A71', '72', 'A72']) {
      const row = offering('Fall 2026', 'X-UH 1000', 'Seven-week course', ['Lee, Ana']);
      row.sections[0]!.session = session;
      const list = courseRows(buildCatalog([row]), 'Fall 2026');
      expect(list[0]!.sections[0]!.session).toBe(session.endsWith('71') ? 'First 7 weeks' : 'Second 7 weeks');
    }
  });

  it('lists one term with display names and core flags', () => {
    const list = courseRows(catalog, 'Fall 2026');
    expect(list.map((row) => row.code)).toEqual(['CCEA-UH 1001X', 'CS-UH 1001', 'ENGR-UH 4010', 'MATH-UH 1012', 'MATH-UH 1021', 'PHYS-UH 4010']);
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
  it('does not pick one course for a title several share', () => {
    expect(matchSchedule(catalog, 'how hard is the capstone project?').courses).toEqual([]);
    expect(matchSchedule(catalog, 'how hard is ENGR 4010?').courses).toEqual(['ENGR-UH 4010']);
  });
  it('finds professors by full name, or by surname next to a teaching word', () => {
    expect(matchSchedule(catalog, 'is professor potsch good').instructors).toEqual(['Thomas Pötsch']);
    expect(matchSchedule(catalog, 'Thomas Pötsch grading?').instructors).toEqual(['Thomas Pötsch']);
    expect(matchSchedule(catalog, 'what is pötsch like').instructors).toEqual([]);
    // "young" is an ordinary word, so a surname match alone does not count.
    expect(matchSchedule(catalog, 'which class is best for young students').instructors).toEqual([]);
  });
  it('distinguishes the Economics MVC section and its professor from the Science course', () => {
    const mvc = buildCatalog([
      offering('Fall 2026', 'MATH-UH 1020', 'Multivariable Calculus with Applications to Science and Engineering', ['Rossi, Marco']),
      offering('Fall 2026', 'MATH-UH 1021', 'Multivariable Calculus with Applications to Economics', ['Demni, Nizar']),
    ], new Date('2026-10-12'));
    expect(matchSchedule(mvc, 'Who teaches MVC for Econ?').courses).toEqual(['MATH-UH 1021']);
    expect(matchSchedule(mvc, 'Nizar MVC').courses).toEqual(['MATH-UH 1021']);
    expect(matchSchedule(mvc, 'Nizar MVC').instructors).toEqual(['Nizar Demni']);
  });
  it('shows current instructors ahead of teachers from a future term', () => {
    const mvc = buildCatalog([
      offering('January 2027', 'MATH-UH 1021', 'Multivariable Calculus with Applications to Economics', ['Mustafa, Rai'], 'Open', ['2027-01-05', '2027-01-15']),
      offering('Fall 2026', 'MATH-UH 1021', 'Multivariable Calculus with Applications to Economics', ['Demni, Nizar']),
    ], new Date('2026-10-12'));
    expect(allCourses(mvc)[0]).toMatchObject({ currentPeople: ['Nizar Demni'], people: ['Rai Mustafa', 'Nizar Demni'] });
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

it('retains both courses in a comparison when only one teacher is named by first name', () => {
  const comparison = buildCatalog([
    offering('Fall 2026', 'MATH-UH 1021', 'Multivariable Calculus', ['Rossi, Marco']),
    offering('Fall 2026', 'MATH-UH 1022', 'Linear Algebra', ['Zantout, Dania']),
  ]);
  const matched = matchSchedule(comparison, 'MVC with Rossi or linalg with Dania?');
  expect(matched.courses.sort()).toEqual(['MATH-UH 1021', 'MATH-UH 1022']);
  expect(matched.instructors.sort()).toEqual(['Dania Zantout', 'Marco Rossi']);
});
