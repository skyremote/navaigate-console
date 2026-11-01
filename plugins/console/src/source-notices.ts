// Code in this stack that was copied or adapted from another project, one entry
// per file, with where it lives. Each repository also carries the licence text
// in its own THIRD_PARTY_NOTICES.md; core's test fails when a file with a T3
// Code header is missing from its list.

export type SourceNotice = { repo: "core" | "fleet" | "console"; file: string; origin: string; licence: "MIT"; use: string };

export const SOURCE_NOTICES: readonly SourceNotice[] = [
  { repo: "core", file: "packages/domain/src/project-icon.ts", origin: "T3 Code", licence: "MIT", use: "Project icon detection and generated monogram" },
  { repo: "core", file: "plugins/github-pr-status/host/gitlab-host.ts", origin: "T3 Code", licence: "MIT", use: "GitLab merge request support" },
  { repo: "fleet", file: "fleet/owner/editor-link.ts", origin: "T3 Code", licence: "MIT", use: "Open a remote project in an editor" },
  { repo: "console", file: "review-tour.ts", origin: "T3 Code", licence: "MIT", use: "Review tour hunk parsing and file coverage" },
];
