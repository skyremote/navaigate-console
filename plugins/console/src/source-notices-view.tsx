import { SOURCE_NOTICES } from "./source-notices";

export function SourceNotices() {
  return (
    <div className="space-y-1">
      <p>
        Copied or adapted code keeps its licence header and is listed in THIRD_PARTY_NOTICES.md in each repository:
      </p>
      <ul aria-label="Code copied or adapted from other projects" className="list-disc space-y-0.5 pl-5">
        {SOURCE_NOTICES.map((notice) => (
          <li key={notice.file}>
            <code>{notice.file}</code>
            {` (${notice.repo}): ${notice.use}, from ${notice.origin}, ${notice.licence} licence`}
          </li>
        ))}
      </ul>
    </div>
  );
}
