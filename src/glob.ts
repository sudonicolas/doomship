/** A path glob as a regex: `**` crosses folders, `*` and `?` stay within one. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** The first area (in the config's order) with a glob matching the path, or null. */
export function areaOf(path: string, areas: Record<string, string[]>): string | null {
  for (const [area, globs] of Object.entries(areas)) {
    if (globs.some((g) => globToRegExp(g).test(path))) return area;
  }
  return null;
}
