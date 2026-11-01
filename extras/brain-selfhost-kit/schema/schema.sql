-- Brain starter schema (final state of migrations 0001, 0002, 0003, 0004, 0005, 0007, 0008).
-- Generated from the open brain CLI migrations. Fleet tables are left out; the aios CLI adds them itself if you use it.
-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT    NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'open',
    venture     TEXT,
    due         TEXT,
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
, sort_key TEXT);

CREATE TABLE IF NOT EXISTS research_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    topic       TEXT    NOT NULL,
    question    TEXT,
    started_at  TEXT    NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'running'
);

CREATE TABLE IF NOT EXISTS sources (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      INTEGER REFERENCES research_runs (id) ON DELETE SET NULL,
    platform    TEXT,
    url         TEXT,
    title       TEXT,
    score       REAL,
    dedup_hash  TEXT    NOT NULL UNIQUE,
    created_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS findings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      INTEGER REFERENCES research_runs (id) ON DELETE CASCADE,
    claim       TEXT    NOT NULL,
    confidence  REAL,
    support     TEXT,
    created_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS people (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    org         TEXT,
    role        TEXT,
    notes       TEXT,
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    title         TEXT    NOT NULL,
    drive_path    TEXT,
    obsidian_path TEXT,
    source        TEXT,
    tags          TEXT,
    created_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS images (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    path        TEXT    NOT NULL,
    prompt      TEXT,
    model       TEXT,
    width       INTEGER,
    height      INTEGER,
    sha256      TEXT,
    source      TEXT,
    b2_url      TEXT,
    created_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_sessions (
    id                  TEXT PRIMARY KEY,
    source              TEXT NOT NULL,
    source_session_id   TEXT NOT NULL,
    source_path         TEXT NOT NULL,
    source_sha256       TEXT NOT NULL,
    cwd                 TEXT,
    started_at          TEXT,
    ended_at            TEXT,
    total_events        INTEGER NOT NULL DEFAULT 0,
    parse_errors        INTEGER NOT NULL DEFAULT 0,
    message_count       INTEGER NOT NULL DEFAULT 0,
    imported_at         TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    UNIQUE(source, source_session_id)
);

CREATE TABLE IF NOT EXISTS conversation_messages (
    id                  TEXT PRIMARY KEY,
    session_id          TEXT NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
    source              TEXT NOT NULL,
    source_session_id   TEXT NOT NULL,
    ordinal             INTEGER NOT NULL,
    role                TEXT NOT NULL,
    timestamp           TEXT,
    text                TEXT NOT NULL,
    text_sha256         TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    UNIQUE(session_id, ordinal, role, text_sha256)
);

CREATE TABLE IF NOT EXISTS media_transcripts (
    id              TEXT PRIMARY KEY,
    platform        TEXT NOT NULL,
    url             TEXT NOT NULL,
    video_id        TEXT,
    title           TEXT,
    channel         TEXT,
    duration_s      INTEGER,
    published_at    TEXT,
    language        TEXT,
    transcript      TEXT NOT NULL,
    segments_json   TEXT,
    transcript_via  TEXT NOT NULL,
    transcript_sha256 TEXT NOT NULL,
    added_by        TEXT,
    fetched_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_digests (
    id               TEXT PRIMARY KEY,
    kind             TEXT NOT NULL,
    ref_id           TEXT NOT NULL,
    source_sha256    TEXT NOT NULL,
    title            TEXT,
    summary          TEXT NOT NULL,
    questions_json   TEXT NOT NULL DEFAULT '[]',
    atoms_json       TEXT NOT NULL DEFAULT '[]',
    tags             TEXT,
    venture          TEXT,
    model            TEXT NOT NULL,
    source_timestamp TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL, source_size INTEGER,
    UNIQUE(kind, ref_id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_status  ON tasks (status);

CREATE INDEX IF NOT EXISTS idx_tasks_venture ON tasks (venture);

CREATE INDEX IF NOT EXISTS idx_tasks_due     ON tasks (due);

CREATE INDEX IF NOT EXISTS idx_research_runs_status ON research_runs (status);

CREATE INDEX IF NOT EXISTS idx_sources_run_id ON sources (run_id);

CREATE INDEX IF NOT EXISTS idx_sources_dedup_hash ON sources (dedup_hash);

CREATE INDEX IF NOT EXISTS idx_findings_run_id ON findings (run_id);

CREATE INDEX IF NOT EXISTS idx_people_org ON people (org);

CREATE INDEX IF NOT EXISTS idx_notes_tags ON notes (tags);

CREATE INDEX IF NOT EXISTS idx_tasks_sort_key ON tasks (sort_key);

CREATE INDEX IF NOT EXISTS idx_images_model  ON images (model);

CREATE INDEX IF NOT EXISTS idx_images_source ON images (source);

CREATE UNIQUE INDEX IF NOT EXISTS idx_images_sha256 ON images (sha256);

CREATE INDEX IF NOT EXISTS idx_conversation_sessions_source
    ON conversation_sessions(source);

CREATE INDEX IF NOT EXISTS idx_conversation_sessions_started
    ON conversation_sessions(started_at);

CREATE INDEX IF NOT EXISTS idx_conversation_messages_session
    ON conversation_messages(session_id, ordinal);

CREATE INDEX IF NOT EXISTS idx_conversation_messages_role
    ON conversation_messages(role);

CREATE INDEX IF NOT EXISTS idx_conversation_messages_text_hash
    ON conversation_messages(text_sha256);

CREATE INDEX IF NOT EXISTS idx_media_transcripts_fetched
    ON media_transcripts(fetched_at);

CREATE INDEX IF NOT EXISTS idx_knowledge_digests_ref
    ON knowledge_digests(ref_id);

CREATE INDEX IF NOT EXISTS idx_knowledge_digests_updated
    ON knowledge_digests(updated_at);
