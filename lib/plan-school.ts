import { courseRows, type Catalog, type CourseRow } from './courses.ts';
import type { PlanSchool } from './plan-schools.ts';

/** A section belongs to its teaching site, not the home campus of its course code. */
export function schoolRows(catalog: Catalog, term: string, school: PlanSchool): CourseRow[] {
  return courseRows(catalog, term).flatMap((row) => {
    const offering = catalog.byCode.get(row.code)?.find((entry) => entry.term === term);
    const numbers = new Set((offering?.sections ?? []).filter((section) => school === 'CAS'
      ? /College of Arts and Science/i.test(section.school ?? '') || (/-UA\s/i.test(row.code) && /New York/i.test(section.location))
      : school === 'Abu Dhabi' ? section.location.startsWith('Abu Dhabi') && !section.school?.includes('College of Arts and Science') : section.location === school || (section.school ?? '').includes(school.replace(' (Global)', ''))).map((section) => section.classNumber));
    const sections = row.sections.filter((section) => numbers.has(section.classNumber));
    return sections.length ? [{ ...row, sections, credits: offering?.sections.find((section) => numbers.has(section.classNumber) && section.units)?.units ?? row.credits }] : [];
  });
}
