CREATE TABLE project_drafts (
 project_id TEXT NOT NULL REFERENCES projects(id),
 user_id TEXT NOT NULL REFERENCES users(id),
 ref TEXT NOT NULL,
 base_commit TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version > 0),
 changes TEXT NOT NULL,
 updated_at INTEGER NOT NULL,
 saving_commit TEXT,
 saving_directory TEXT,
 last_saved_version INTEGER,
 PRIMARY KEY(project_id,user_id)
);
