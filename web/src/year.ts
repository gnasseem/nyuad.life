/** Class years and standings, mirroring lib/board.ts: the academic year turns over on 31 August. */
import type { Standing } from './api';

export function academicYearOf(now = new Date()): number {
  const month = now.getUTCMonth();
  const rolledOver = month > 7 || (month === 7 && now.getUTCDate() >= 31);
  return rolledOver ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
}

export function standingFor(classOf: number, now = new Date()): Standing {
  const yearsLeft = classOf - academicYearOf(now);
  if (yearsLeft >= 3) return 'first-year';
  if (yearsLeft === 2) return 'sophomore';
  if (yearsLeft === 1) return 'junior';
  if (yearsLeft === 0) return 'senior';
  return 'alumni';
}

export function classYears(now = new Date()): Array<{ value: number; label: string }> {
  const academicYear = academicYearOf(now);
  return [
    { value: academicYear + 3, label: `Class of ${academicYear + 3} · first year` },
    { value: academicYear + 2, label: `Class of ${academicYear + 2} · sophomore` },
    { value: academicYear + 1, label: `Class of ${academicYear + 1} · junior` },
    { value: academicYear, label: `Class of ${academicYear} · senior` },
    { value: academicYear - 1, label: 'Graduated' },
  ];
}

/** What to say when someone's standing has moved on since they last opened the app. */
export function promotionMessage(from: Standing, to: Standing): { title: string; message: string } | null {
  if (from === to) return null;
  switch (to) {
    case 'sophomore':
      return { title: 'You are a sophomore now', message: 'First year done. Questions from new first-years will start finding you, since you just lived it.' };
    case 'junior':
      return { title: 'You are a junior now', message: 'Halfway there. Study away, capstone mentors and internships are the questions you can help with now.' };
    case 'senior':
      return { title: 'You are a senior now', message: 'Last lap. Capstone and what-comes-after questions will come your way, and your answers carry the most weight.' };
    case 'alumni':
      return { title: 'You graduated', message: 'Congratulations. You are alumni here now, and grad school and job questions will find you.' };
    default:
      return null;
  }
}
