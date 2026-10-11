// GitHub only accepts review comments on lines that appear in the diff (added lines and the
// unchanged context lines around them). This parses a file's unified `patch` into those lines.

export type FileDiff = {
  /** new-file line number → text, for every line GitHub will accept a comment on */
  commentable: Map<number, string>;
  /** new-file line numbers that this PR added */
  added: Set<number>;
};

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parsePatch(patch: string): FileDiff {
  const commentable = new Map<number, string>();
  const added = new Set<number>();
  let line = 0;
  let inHunk = false;
  for (const raw of patch.split("\n")) {
    const hunk = HUNK.exec(raw);
    if (hunk) {
      line = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    const marker = raw[0];
    const text = raw.slice(1);
    if (marker === "+") {
      commentable.set(line, text);
      added.add(line);
      line++;
    } else if (marker === " ") {
      commentable.set(line, text);
      line++;
    }
    // "-" lines exist only in the old file; "\ No newline at end of file" is metadata
  }
  return { commentable, added };
}

/** A few lines around `line`, used to fingerprint a finding so the same issue is recognised later. */
export function surroundingCode(diff: FileDiff, line: number, radius = 2): string {
  const out: string[] = [];
  for (let n = line - radius; n <= line + radius; n++) {
    const text = diff.commentable.get(n);
    if (text !== undefined) out.push(text.trim());
  }
  return out.join("\n");
}
