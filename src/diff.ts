/** One file in a unified diff from git. */
export type FileDiff = {
  path: string;
  /** The old path, for a rename. */
  from?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  binary: boolean;
  added: number;
  removed: number;
  /** Line numbers (from 1) in the new file of each added line. */
  addedLines: number[];
  /** The file's part of the patch, header included. */
  patch: string;
};

/**
 * Splits git's patch into files. Paths come from the rename lines, else the header
 * `diff --git a/P b/P`, whose two halves are the same path when the file wasn't renamed.
 * Needs `core.quotePath=false` and the default a/ b/ prefixes.
 */
export function parsePatch(patch: string): FileDiff[] {
  const files: FileDiff[] = [];
  const blocks = patch.split(/^(?=diff --git )/m).filter((b) => b.startsWith('diff --git '));
  for (const block of blocks) {
    const lines = block.split('\n');
    const header = lines[0].slice('diff --git '.length);
    const half = (header.length - 1) / 2;
    let path = header.slice(half + 1).replace(/^b\//, '');
    let from: string | undefined;
    let status: FileDiff['status'] = 'modified';
    let binary = false;
    let added = 0, removed = 0, newLine = 0, inHunk = false;
    const addedLines: number[] = [];
    for (const line of lines.slice(1)) {
      if (!inHunk) {
        if (line.startsWith('new file mode')) status = 'added';
        else if (line.startsWith('deleted file mode')) status = 'deleted';
        else if (line.startsWith('rename from ')) from = line.slice('rename from '.length);
        else if (line.startsWith('rename to ')) { path = line.slice('rename to '.length); status = 'renamed'; }
        else if (line.startsWith('Binary files ')) binary = true;
      }
      const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) { inHunk = true; newLine = Number(hunk[1]); continue; }
      if (!inHunk) continue;
      if (line.startsWith('+')) { added++; addedLines.push(newLine++); }
      else if (line.startsWith('-')) removed++;
      else if (line.startsWith(' ')) newLine++;
    }
    files.push({ path, ...(from !== undefined && { from }), status, binary, added, removed, addedLines, patch: block });
  }
  return files;
}
