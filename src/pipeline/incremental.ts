// Incremental reviews: once a PR has been reviewed, the next review only looks at the commits
// pushed since. This decides when that's safe; run.ts makes the GitHub calls.
import type { ChangedFile } from "./filter";

const MAX_COMPARE_FILES = 300; // GitHub's compare API lists at most this many files

/**
 * The files changed between the last reviewed commit and the head, from GitHub's compare API.
 * Null means "review the whole PR": the history was rewritten (rebase, force-push), so the old
 * commit isn't an ancestor anymore, or the file list may have been cut off.
 */
export function newChangesFrom(compare: { status: string; files?: ChangedFile[] }): ChangedFile[] | null {
  if (compare.status !== "ahead") return null;
  const files = compare.files ?? [];
  if (files.length >= MAX_COMPARE_FILES) return null;
  return files;
}
