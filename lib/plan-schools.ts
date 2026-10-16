import type { Catalog } from './courses.ts';
import { isNewYorkLocation } from './plan-school.ts';

export interface PlanSchool { id: string; label: string; group: 'Campus' | 'School' | 'Study away' }
const cache = new WeakMap<Catalog, PlanSchool[]>();

/** Build the selector from schools and teaching locations actually present in Albert's snapshot. */
export function planSchools(catalog: Catalog): PlanSchool[] {
  const saved = cache.get(catalog);
  if (saved) return saved;
  const schools = new Map<string, PlanSchool>();
  for (const offerings of catalog.byCode.values()) for (const offering of offerings) for (const section of offering.sections) {
    const school = section.school ?? offering.school ?? '';
    const location = section.location;
    if (location.startsWith('Abu Dhabi')) schools.set('Abu Dhabi', { id: 'Abu Dhabi', label: 'Abu Dhabi', group: 'Campus' });
    if (location.startsWith('Abu Dhabi') && /-GH\s/.test(offering.code)) schools.set('Abu Dhabi graduate', { id: 'Abu Dhabi graduate', label: 'Abu Dhabi · graduate classes', group: 'School' });
    if (isNewYorkLocation(location)) schools.set('New York', { id: 'New York', label: 'New York · all schools', group: 'Campus' });
    if (location === 'Shanghai') schools.set('NYU Shanghai', { id: 'NYU Shanghai', label: 'NYU Shanghai', group: 'Campus' });
    if (school === 'College of Arts and Science' || (!school && /-UA\s/.test(offering.code) && /New York/.test(location))) {
      schools.set('CAS', { id: 'CAS', label: 'College of Arts and Science', group: 'School' });
    } else if (school && school !== 'NYU Abu Dhabi' && !/global/i.test(school)) {
      schools.set(school, { id: school, label: school, group: school === 'NYU Shanghai' ? 'Campus' : 'School' });
    }
    const site = location === 'London (TSOA)' ? 'NYU London (Global)' : location;
    if (/^NYU .+ \(Global\)$/.test(site)) schools.set(site, { id: site, label: site.replace(/^NYU | \(Global\)$/g, ''), group: 'Study away' });
  }
  const sorted = [...schools.values()].sort((a, b) => (a.group === b.group ? a.label.localeCompare(b.label) : ['Campus', 'School', 'Study away'].indexOf(a.group) - ['Campus', 'School', 'Study away'].indexOf(b.group)));
  cache.set(catalog, sorted);
  return sorted;
}

export function isPlanSchool(catalog: Catalog, value: string): boolean {
  return planSchools(catalog).some((school) => school.id === value);
}
