// Step 4: drop files that only add noise and cost (lockfiles, generated or vendored code, binaries).
// The biggest single lever on both bill and comment quality.

export type ChangedFile = {
  filename: string;
  status: string; // added | modified | removed | renamed | copied | changed | unchanged
  additions: number;
  deletions: number;
  patch?: string; // GitHub omits it for binaries and very large diffs
};

export type FilterResult = { review: ChangedFile[]; skipped: { path: string; reason: string }[] };

const NOISE = [
  "**/package-lock.json", "**/yarn.lock", "**/pnpm-lock.yaml", "**/bun.lock", "**/bun.lockb",
  "**/Cargo.lock", "**/poetry.lock", "**/Gemfile.lock", "**/composer.lock", "**/go.sum", "**/uv.lock",
  "**/*.min.js", "**/*.min.css", "**/*.map", "**/*.snap",
  "**/dist/**", "**/build/**", "**/vendor/**", "**/node_modules/**", "**/__generated__/**", "**/*.generated.*",
];

const matches = (patterns: string[], path: string) =>
  patterns.some((p) => new Bun.Glob(p).match(path) || new Bun.Glob(p).match(`./${path}`));

export function filterFiles(files: ChangedFile[], ignore: string[]): FilterResult {
  const review: ChangedFile[] = [];
  const skipped: FilterResult["skipped"] = [];
  for (const f of files) {
    if (f.status === "removed") skipped.push({ path: f.filename, reason: "deleted" });
    else if (matches(ignore, f.filename)) skipped.push({ path: f.filename, reason: "ignored by config" });
    else if (matches(NOISE, f.filename)) skipped.push({ path: f.filename, reason: "generated or lockfile" });
    else if (!f.patch) skipped.push({ path: f.filename, reason: "binary or too large to diff" });
    else review.push(f);
  }
  return { review, skipped };
}
