import { homedir } from 'node:os';
import { join } from 'node:path';

/** Everything doomship keeps per repo: exports, build products, runs. DOOMSHIP_CACHE moves it (tests). */
export const cacheRoot = () => process.env.DOOMSHIP_CACHE ?? join(homedir(), 'Library/Caches/doomship');

export const repoCache = (repoName: string) => join(cacheRoot(), repoName);
/** The change's tree, exported; one per repo so builds stay incremental. */
export const srcDir = (repoName: string) => join(repoCache(repoName), 'src');
export const runDir = (repoName: string, runId: string) => join(repoCache(repoName), 'runs', runId);
