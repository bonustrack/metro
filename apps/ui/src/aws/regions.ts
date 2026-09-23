const REGION_NAMES: Record<string, string> = {
  'eu-central-2': 'Europe (Zurich)',
  'us-east-1': 'US East (N. Virginia)',
};

const LAUNCH_REGIONS = Object.keys(REGION_NAMES);

export const launchRegions = (enabled: string[]): string[] =>
  enabled.length === 0 ? LAUNCH_REGIONS : LAUNCH_REGIONS.filter((code) => enabled.includes(code));

export const regionName = (code: string): string => REGION_NAMES[code] ?? code;
