// `.selfreview.yml`, read from the PR's base branch (ARCHITECTURE §7), so a PR can't change the
// rules it is reviewed by. Missing or invalid file → defaults, with the problem shown in the summary.
import { parse } from "yaml";
import { z } from "zod";

export const RepoConfig = z.object({
  instructions: z.string().max(4000).default(""),
  ignore: z.array(z.string()).max(100).default([]),
  risky_paths: z.array(z.string()).max(100).default([]),
  min_severity: z.enum(["low", "medium", "high"]).default("medium"),
  max_comments: z.number().int().min(1).max(50).default(15),
  skip_drafts: z.boolean().default(true),
  skip_authors: z.array(z.string()).default(["dependabot[bot]", "renovate[bot]"]),
  skip_labels: z.array(z.string()).default(["no-review"]),
  models: z.object({ small: z.string().optional(), large: z.string().optional() }).default({}),
});
export type RepoConfig = z.infer<typeof RepoConfig>;

export const CONFIG_PATH = ".selfreview.yml";

export function parseRepoConfig(text: string | null): { config: RepoConfig; warning?: string } {
  if (text === null) return { config: RepoConfig.parse({}) };
  try {
    const result = RepoConfig.safeParse(parse(text) ?? {});
    if (result.success) return { config: result.data };
    return { config: RepoConfig.parse({}), warning: `${CONFIG_PATH} ignored: ${z.prettifyError(result.error)}` };
  } catch (err) {
    return { config: RepoConfig.parse({}), warning: `${CONFIG_PATH} ignored: not valid YAML` };
  }
}

export type PrFacts = { draft: boolean; author: string; labels: string[] };

/** Repo-level skips, applied by the worker once it has read the config. */
export function skipReason(config: RepoConfig, pr: PrFacts): string | null {
  if (pr.draft && config.skip_drafts) return "draft";
  if (config.skip_authors.includes(pr.author)) return `author:${pr.author}`;
  const label = pr.labels.find((l) => config.skip_labels.includes(l));
  if (label) return `label:${label}`;
  return null;
}
