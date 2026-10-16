import { courseRows, type Catalog, type CourseRow } from './courses.ts';

export function isNewYorkLocation(location: string): boolean {
  return /^(New York|NYU New York|Washington Square|Brooklyn Campus|Industry City|Medical Center(?: Long Island)?|Dental Center|Inst\. of Fine Arts|Off Campus|Online|Distance Learning\/Synchronous|St\. Thomas Aquinas College|Sarah Lawrence)$/.test(location);
}

/** A section belongs to its teaching school or location, not the home campus of its course code. */
export function schoolRows(catalog: Catalog, term: string, school: string): CourseRow[] {
  return courseRows(catalog, term).flatMap((row) => {
    const offering = catalog.byCode.get(row.code)?.find((entry) => entry.term === term);
    const numbers = new Set((offering?.sections ?? []).filter((section) => {
      const source = section.school ?? offering?.school ?? '';
      if (school === 'Abu Dhabi') return section.location.startsWith('Abu Dhabi') && !/-GH\s/.test(row.code);
      if (school === 'Abu Dhabi graduate') return section.location.startsWith('Abu Dhabi') && /-GH\s/.test(row.code);
      if (school === 'New York') return isNewYorkLocation(section.location);
      if (school === 'NYU Shanghai') return section.location === 'Shanghai';
      if (school === 'CAS') return (isNewYorkLocation(section.location) && source === 'College of Arts and Science') || (!source && /-UA\s/.test(row.code) && section.location === 'NYU New York');
      if (school === 'NYU London (Global)') return section.location === school || section.location === 'London (TSOA)';
      if (/\(Global\)$/.test(school)) return section.location === school;
      return source === school && isNewYorkLocation(section.location);
    }).map((section) => section.classNumber));
    // Cross-listed classes can be returned under several teaching schools; each physical section appears once.
    const sections = [...new Map(row.sections.filter((section) => numbers.has(section.classNumber)).map((section) => [section.classNumber, section])).values()];
    return sections.length ? [{ ...row, sections, credits: offering?.sections.find((section) => numbers.has(section.classNumber) && section.units)?.units ?? row.credits }] : [];
  });
}
