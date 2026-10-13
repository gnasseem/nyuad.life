export const PLAN_SCHOOLS = [
  { id: 'Abu Dhabi', label: 'Abu Dhabi' },
  { id: 'CAS', label: 'College of Arts and Science (New York)' },
  { id: 'NYU Paris (Global)', label: 'Paris' },
  { id: 'NYU London (Global)', label: 'London' },
  { id: 'NYU Florence (Global)', label: 'Florence' },
  { id: 'NYU Madrid (Global)', label: 'Madrid' },
  { id: 'NYU Berlin (Global)', label: 'Berlin' },
  { id: 'NYU Prague (Global)', label: 'Prague' },
  { id: 'NYU Shanghai (Global)', label: 'Shanghai' },
  { id: 'NYU Accra (Global)', label: 'Accra' },
  { id: 'NYU Buenos Aires (Global)', label: 'Buenos Aires' },
  { id: 'NYU Washington DC (Global)', label: 'Washington, DC' },
] as const;

export type PlanSchool = (typeof PLAN_SCHOOLS)[number]['id'];

export function isPlanSchool(value: string): value is PlanSchool {
  return PLAN_SCHOOLS.some((school) => school.id === value);
}
