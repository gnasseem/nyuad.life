/** Class years and standings, mirroring lib/board.ts: the academic year turns over on 1 May. */
import type { Standing } from './api';

function academicYearOf(now = new Date()): number {
  const rolledOver = now.getUTCMonth() >= 4; // May onwards
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
