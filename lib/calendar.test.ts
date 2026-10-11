import { describe, expect, it } from 'vitest';
import { asksCalendar, calendarCovers, calendarEvents, calendarText, parseCalendar } from './calendar.ts';
import type { OfficialDoc } from './official.ts';

/** The registrar's page as the crawler saves it: one line per row, weekdays in brackets, no years. */
const REGISTRAR: OfficialDoc = {
  id: 'cal',
  url: 'https://nyuad.nyu.edu/en/academics/undergraduate/academic-calendar.html',
  title: 'Undergraduate Academic Calendar',
  section: 'academics',
  breadcrumbs: [],
  fetchedAt: '2026-10-11T10:00:00.000Z',
  text: 'All registration deadlines are 4pm UAE time on the day listed.',
  sections: [
    { title: '2026-2027', text: '2025-2026 Academic Calendar\n\n2024-2025 Academic Calendar' },
    {
      title: 'Fall Semester 1',
      text: '| Date | Event\n| Aug 31 (Mon) | First day of classes\n| Sep 4 (Fri) | Add/drop deadline for 7-week courses (4pm deadline)\n| Sep 11 (Fri) | Add/drop deadline for 14-week courses (4pm deadline)\n| Oct 2 (Fri) | Withdrawal deadline for 7-week courses (4pm deadline)\n| Oct 18-22 (Sun-Thu) | No classes: Final exams for 7-week courses\n| Oct 23-25 (Fri-Sun) | No classes: Fall Break',
    },
    {
      title: 'Fall Semester 2',
      text: '| Date | Event\n| Oct 26 (Mon) | Classes resume\n| Oct 30 (Fri) | Add/drop deadline for 7-week courses (4pm deadline)\n| Nov 20 (Fri) | Withdrawal deadline for 14-week courses (4pm deadline)\n| Dec 2-3 (Wed-Thu) | No classes: National Day Holiday*\n| Dec 16-22 (Wed-Tue) | Final exams\n| Feb 1 (Mon) | Conferral for Fall/January degree completers',
    },
    {
      title: 'January Term 2027',
      text: '| Date | Event\n| For Courses in Abu Dhabi |\n| Jan 4 (Mon) | Classes begin / Withdraw deadline - classes are letter graded after this date\n| For Courses in Global Locations |\n| Jan 5 (Tue) | Classes begin / Withdraw deadline - classes are letter graded after this date\n\nAM: Orientation\n\nPM: First Class Meetings',
    },
    {
      title: 'Spring Semester 1',
      text: '| Date | Event\n| Jan 19 (Tue) | First day of classes\n| Feb 1 (Mon) | Add/drop deadline for 14-week courses (4:00pm deadline)\n| Spring Break\n\nMarch 8-12 (Mon-Fri) | No classes: Spring Break / Eid Al-Fitr Holiday\n| March 13-17 (Sat-Wed) | Final Exams for first 7-week courses',
    },
  ],
};

/** The bulletin's copy: a date and its event on lines of their own, the year in every heading. */
const BULLETIN: OfficialDoc = {
  ...REGISTRAR,
  url: 'https://bulletins.nyu.edu/undergraduate/abu-dhabi/academic-calendar/',
  sections: [
    { title: '2026–2027 · Fall Semester II', text: 'Abu Dhabi: Calendar\n\n| Date\n| Event\n\n| October 26\n| Classes resume\n\n| October 30\n| Add/drop deadline for Second 7-week courses\n\n| November 20\n| Withdrawal deadline for 14-week courses\n\n| December 14\n| Last day of classes\n\n| December 16-22\n| Final exams' },
    { title: '2026–2027 · Winter Break', text: 'Abu Dhabi: Calendar\n\n| Date\n| Event\n\n| December 23 - January 3\n| No classes: Winter break' },
    { title: '2026–2027 · Spring Semester 1', text: 'Abu Dhabi: Calendar\n\n| Date\n| Event\n\n| January 19\n| Classes begin\n\n| January 25\n| Add/drop deadline for 7-week courses\n\n| February 7-March 8\n| Ramadan*\n\n| March 8-12\n| No classes: Spring Break / Eid Al-Fitr Holiday' },
  ],
};

const TODAY = '2026-10-11';

describe('parseCalendar', () => {
  const calendar = parseCalendar(REGISTRAR)!;

  it('gives every row the year of its half of the academic year', () => {
    expect(calendar.year).toBe('2026–2027');
    const find = (label: RegExp) => calendar.events.find((event) => label.test(event.label));
    expect(find(/14-week courses \(4pm/)).toMatchObject({ start: '2026-09-11', end: '2026-09-11', term: 'fall', section: 'Fall Semester 1' });
    expect(find(/Fall Break/)).toMatchObject({ start: '2026-10-23', end: '2026-10-25' });
    expect(find(/Conferral/)).toMatchObject({ start: '2027-02-01', term: 'fall' });
    expect(find(/Spring Break/)).toMatchObject({ start: '2027-03-08', end: '2027-03-12', term: 'spring', section: 'Spring Semester 1' });
    expect(find(/National Day/)!.label).toBe('No classes: National Day Holiday');
  });

  it('keeps the groups inside a term and the notes that run on from a row', () => {
    const global = calendar.events.find((event) => event.start === '2027-01-05')!;
    expect(global.section).toBe('January Term 2027 · For Courses in Global Locations');
    expect(global.label).toContain('AM: Orientation; PM: First Class Meetings');
    expect(calendar.events.find((event) => event.start === '2027-01-04')!.section).toBe('January Term 2027 · For Courses in Abu Dhabi');
    // A caption above a row ("Spring Break") is not a heading for the rows after it.
    expect(calendar.events.find((event) => /first 7-week/.test(event.label))!.section).toBe('Spring Semester 1');
  });

  it('reads the bulletin layout and ranges across a month or the new year', () => {
    const bulletin = parseCalendar({ ...BULLETIN, sections: [...BULLETIN.sections!, ...REGISTRAR.sections!.slice(1, 3)] })!;
    expect(bulletin.events.find((event) => /Winter break/.test(event.label))).toMatchObject({ start: '2026-12-23', end: '2027-01-03', section: 'Winter Break' });
    expect(bulletin.events.find((event) => /Ramadan/.test(event.label))).toMatchObject({ start: '2027-02-07', end: '2027-03-08', label: 'Ramadan' });
  });

  it('turns down a page that is not a calendar', () => {
    expect(parseCalendar({ ...REGISTRAR, sections: [], text: 'Registration opens in October. Talk to your advisor.' })).toBeNull();
  });
});

describe('calendarEvents', () => {
  const calendar = parseCalendar(REGISTRAR)!;
  const labels = (question: string) => calendarEvents(calendar, question, TODAY).map((event) => `${event.start} ${event.label}`);

  it('answers "when is fall break" with the fall break row only', () => {
    expect(labels('when is fall break')).toEqual(['2026-10-23 No classes: Fall Break']);
  });

  it('gives add/drop for this term and the next, without the withdrawal rows', () => {
    const rows = labels('when is the add drop deadline');
    expect(rows).toContain('2026-10-30 Add/drop deadline for 7-week courses (4pm deadline)');
    expect(rows).toContain('2027-02-01 Add/drop deadline for 14-week courses (4:00pm deadline)');
    expect(rows.some((row) => /Withdraw/.test(row))).toBe(false);
  });

  it('reads "can I still drop" as add/drop and withdrawal', () => {
    expect(labels('can I still drop a class?')).toContain('2026-11-20 Withdrawal deadline for 14-week courses (4pm deadline)');
  });

  it('keeps to the term a question names', () => {
    expect(labels('when does spring semester start')).toEqual(['2027-01-19 First day of classes']);
    expect(labels('when are final exams this semester')).toEqual(['2026-10-18 No classes: Final exams for 7-week courses', '2026-12-16 Final exams']);
  });

  it('leaves questions that are not about a date alone', () => {
    expect(asksCalendar('is the add drop period stressful')).toBe(false);
    expect(asksCalendar('when is fall break')).toBe(true);
    expect(labels('best food on campus')).toEqual([]);
  });

  it('marks rows passed or how far off, with weekday and year', () => {
    const text = calendarText(calendar, calendarEvents(calendar, 'add drop deadline', TODAY), TODAY);
    expect(text).toContain('Today is Sun, 11 Oct 2026');
    expect(text).toContain('Registration deadlines are at 4pm Abu Dhabi time');
    expect(text).toMatch(/Fri, 11 Sept? 2026 \(passed\): Add\/drop deadline for 14-week courses/);
    expect(text).toMatch(/Fri, 30 Oct 2026 \(in 19 days\): Add\/drop deadline for 7-week courses .*\[Fall Semester 2\]/);
  });

  it('covers its own academic year, however long ago it was fetched', () => {
    expect(calendarCovers(calendar, TODAY)).toBe(true);
    expect(calendarCovers(calendar, '2027-09-01')).toBe(false);
  });
});
