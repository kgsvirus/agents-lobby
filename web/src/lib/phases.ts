// The phases every project follows. No work-item store exists yet, so this is
// the static vocabulary the Projects module renders; counts arrive with the API.
export const PHASES = [
  'Planning',
  'Requirements',
  'System Design',
  'Implementation plan',
  'Implementation',
  'Testing',
  'Deployment',
  'Maintenance',
] as const;
