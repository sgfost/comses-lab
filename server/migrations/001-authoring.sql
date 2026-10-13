CREATE TABLE project_metadata (
 project_id TEXT PRIMARY KEY REFERENCES projects(id),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
 data_origins TEXT NOT NULL DEFAULT '[]',
 source_project_id TEXT REFERENCES projects(id), source_commit TEXT,
 source_private INTEGER NOT NULL DEFAULT 0 CHECK(source_private IN (0,1))
);
INSERT INTO project_metadata(project_id) SELECT id FROM projects;
CREATE TABLE project_provisions (
 actor_id TEXT NOT NULL REFERENCES users(id), request_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('create','fork')), request_hash TEXT NOT NULL,
 project_id TEXT NOT NULL UNIQUE, repo_name TEXT NOT NULL UNIQUE,
 prepared_commit TEXT NOT NULL, prepared_directory TEXT NOT NULL, metadata TEXT NOT NULL,
 source_project_id TEXT REFERENCES projects(id), source_commit TEXT,
 source_private INTEGER NOT NULL DEFAULT 0,
 provider_id INTEGER,
 stage TEXT NOT NULL CHECK(stage IN ('prepared','creating','created','populated','public','completed')),
 PRIMARY KEY(actor_id, request_id)
);
