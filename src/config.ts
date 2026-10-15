import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { git } from './git.ts';

type Common = {
  /** The caption band's colour, #RRGGBB. */
  accent: string;
  /** Where the accent came from: the config, an AccentColor asset's path, or the default. */
  accentFrom: string;
  /** Area name to globs, first match wins; prepare tags each changed file with its area. */
  areas: Record<string, string[]>;
  /** Plain-language facts about the app for the agent writing the demo. */
  notes: string[];
  /** The config file this came from. */
  file: string;
};
export type IosConfig = Common & {
  platform: 'ios';
  project: string;
  scheme: string;
  uiTestTarget: string;
  injectInto: string;
  simulator: string;
  launchArguments: string[];
};
export type WebConfig = Common & {
  platform: 'web';
  start?: { command: string; url: string };
  url?: string;
};
export type Config = IosConfig | WebConfig;

/** Used when the config has no accent and the app has no AccentColor asset: GitHub's dark grey. */
export const defaultAccent = '#24292F';
export const configFileName = '.doomship.json';

type Field = { about: string; platforms: ('ios' | 'web')[]; required?: boolean };
const fields: Record<string, Field> = {
  platform: { about: '"ios" or "web"', platforms: ['ios', 'web'], required: true },
  project: { about: 'the .xcodeproj or .xcworkspace, relative to the repo', platforms: ['ios'], required: true },
  scheme: { about: 'the Xcode scheme that builds the app', platforms: ['ios'], required: true },
  uiTestTarget: { about: 'the UI test target the demo runs in', platforms: ['ios'], required: true },
  injectInto: { about: 'a Swift file in that target the demo is appended to, relative to the repo', platforms: ['ios'], required: true },
  simulator: { about: 'the device type to record on, such as "iPhone 17"', platforms: ['ios'] },
  launchArguments: { about: 'arguments the app is launched with, a list of strings', platforms: ['ios'] },
  start: { about: 'how to start the app: { "command": "npm run dev", "url": "http://localhost:3000" }', platforms: ['web'] },
  url: { about: 'a URL already serving the app, such as a preview deployment', platforms: ['web'] },
  accent: { about: 'the caption band colour, "#RRGGBB"; defaults to the app\'s AccentColor asset', platforms: ['ios', 'web'] },
  areas: { about: 'area name to a list of globs, such as { "ui": ["App/**"] }', platforms: ['ios', 'web'] },
  notes: { about: 'facts about the app for the agent, a list of strings', platforms: ['ios', 'web'] },
};

const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');
const isHex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
const show = (v: unknown) => JSON.stringify(v);

/**
 * Checks a parsed config. Returns every problem, one line each, naming the field, what was wrong
 * and what it should be; or the config with defaults filled in (except the accent, see loadConfig).
 */
export function validateConfig(raw: unknown, file: string): { config: Omit<Config, 'accent' | 'accentFrom'> & { accent?: string } } | { errors: string[] } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { errors: ['the config must be a JSON object'] };
  const c = raw as Record<string, unknown>;
  const errors: string[] = [];
  const platform = c.platform;
  if (platform !== 'ios' && platform !== 'web') {
    errors.push(platform === undefined ? 'platform: required, "ios" or "web"' : `platform: must be "ios" or "web", not ${show(platform)}`);
    return { errors };
  }

  for (const name of Object.keys(c)) {
    const f = fields[name];
    if (!f) {
      const known = Object.keys(fields).filter((k) => fields[k].platforms.includes(platform));
      errors.push(`${name}: not a field doomship knows; the fields for ${platform} are ${known.join(', ')}`);
    } else if (!f.platforms.includes(platform)) {
      errors.push(`${name}: only for ${f.platforms.join(' and ')} apps, and this one is ${platform}`);
    }
  }
  for (const [name, f] of Object.entries(fields)) {
    if (f.required && f.platforms.includes(platform) && c[name] === undefined) errors.push(`${name}: required for ${platform}, ${f.about}`);
  }

  const nonEmptyString = (name: string) => {
    const v = c[name];
    if (v !== undefined && (typeof v !== 'string' || !v.trim())) errors.push(`${name}: must be ${fields[name].about}, not ${show(v)}`);
  };
  const stringList = (name: string) => {
    const v = c[name];
    if (v !== undefined && !isStringList(v)) errors.push(`${name}: must be ${fields[name].about}, not ${show(v)}`);
  };

  if (c.accent !== undefined && !isHex(c.accent)) errors.push(`accent: must be a hex colour like "#5856D6", not ${show(c.accent)}`);
  stringList('notes');
  if (c.areas !== undefined) {
    if (typeof c.areas !== 'object' || c.areas === null || Array.isArray(c.areas)) {
      errors.push(`areas: must be ${fields.areas.about}, not ${show(c.areas)}`);
    } else {
      for (const [area, globs] of Object.entries(c.areas)) {
        if (!isStringList(globs) || !globs.length) errors.push(`areas.${area}: must be a non-empty list of globs, not ${show(globs)}`);
      }
    }
  }

  if (platform === 'ios') {
    for (const name of ['project', 'scheme', 'uiTestTarget', 'injectInto', 'simulator']) nonEmptyString(name);
    stringList('launchArguments');
    if (typeof c.project === 'string' && c.project.trim() && !/\.(xcodeproj|xcworkspace)$/.test(c.project)) {
      errors.push(`project: must end in .xcodeproj or .xcworkspace, not ${show(c.project)}`);
    }
    if (typeof c.injectInto === 'string' && c.injectInto.trim() && !c.injectInto.endsWith('.swift')) {
      errors.push(`injectInto: must be a .swift file, not ${show(c.injectInto)}`);
    }
  } else {
    nonEmptyString('url');
    if (c.start !== undefined) {
      const s = c.start as Record<string, unknown>;
      if (typeof s !== 'object' || s === null || typeof s.command !== 'string' || typeof s.url !== 'string' || !s.command || !s.url) {
        errors.push(`start: must be ${fields.start.about}, not ${show(c.start)}`);
      }
    }
    if (c.start === undefined && c.url === undefined) errors.push(`start or url: one is required for web; start is ${fields.start.about}, url is ${fields.url.about}`);
    if (c.start !== undefined && c.url !== undefined) errors.push('start and url: give one, not both');
  }

  if (errors.length) return { errors };
  const common = {
    file,
    accent: c.accent as string | undefined,
    areas: (c.areas as Record<string, string[]>) ?? {},
    notes: (c.notes as string[]) ?? [],
  };
  return platform === 'ios'
    ? {
        config: {
          ...common, platform,
          project: c.project as string, scheme: c.scheme as string, uiTestTarget: c.uiTestTarget as string,
          injectInto: c.injectInto as string,
          simulator: (c.simulator as string) ?? 'iPhone 17',
          launchArguments: (c.launchArguments as string[]) ?? [],
        },
      }
    : { config: { ...common, platform, start: c.start as WebConfig['start'], url: c.url as string | undefined } };
}

/** One colour component from an asset catalog: "0.345" (0 to 1), "0x58" or "88" (0 to 255). */
function component(v: unknown): number | undefined {
  if (typeof v === 'number') v = String(v);
  if (typeof v !== 'string') return undefined;
  const n = v.startsWith('0x') ? parseInt(v, 16) : v.includes('.') ? Math.round(parseFloat(v) * 255) : parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 && n <= 255 ? n : undefined;
}

/** The light-appearance colour of an AccentColor.colorset's Contents.json, as #RRGGBB. */
export function colorsetHex(contents: string): string | undefined {
  let json: { colors?: { appearances?: unknown[]; color?: { components?: Record<string, unknown> } }[] };
  try {
    json = JSON.parse(contents);
  } catch {
    return undefined;
  }
  const entry = json.colors?.find((c) => !c.appearances?.length && c.color?.components);
  const comps = entry?.color?.components;
  if (!comps) return undefined;
  const rgb = [comps.red, comps.green, comps.blue].map(component);
  if (rgb.some((n) => n === undefined)) return undefined;
  return '#' + rgb.map((n) => n!.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/**
 * The app's AccentColor asset, read from the repo's tracked files. With several (an app and its
 * widgets), the one under a folder named like the scheme wins, then the shallowest.
 */
export function findAccentColor(repo: string, scheme?: string): { hex: string; path: string } | undefined {
  const r = git(repo, ['ls-files', '--', '*AccentColor.colorset/Contents.json']);
  if (!r.ok) return undefined;
  const paths = r.stdout.split('\n').filter(Boolean);
  const rank = (p: string) => (scheme && p.split('/')[0] === scheme ? 0 : 1) * 1000 + p.split('/').length;
  paths.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  for (const path of paths) {
    const full = join(repo, path);
    if (!existsSync(full)) continue;
    const hex = colorsetHex(readFileSync(full, 'utf8'));
    if (hex) return { hex, path };
  }
  return undefined;
}

export class ConfigError extends Error {}

/** Loads `--config <file>`, else the repo's .doomship.json; validates it and fills in the accent. */
export function loadConfig(repo: string, configPath?: string): Config {
  const file = configPath ? resolve(configPath) : join(repo, configFileName);
  if (!existsSync(file)) {
    throw new ConfigError(configPath
      ? `${file}: no such file`
      : `${file}: no config; add one to the repo or pass --config <file> (see examples/)`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new ConfigError(`${file}: not valid JSON: ${(e as Error).message}`);
  }
  const result = validateConfig(raw, file);
  if ('errors' in result) throw new ConfigError(`${file}:\n${result.errors.map((e) => `  ${e}`).join('\n')}`);
  const { config } = result;
  if (config.accent) return { ...config, accent: config.accent.toUpperCase(), accentFrom: 'config' } as Config;
  const found = findAccentColor(repo, config.platform === 'ios' ? config.scheme : undefined);
  return (found
    ? { ...config, accent: found.hex, accentFrom: found.path }
    : { ...config, accent: defaultAccent, accentFrom: 'default' }) as Config;
}
