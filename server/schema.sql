PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
 password_hash TEXT NOT NULL, forgejo_id INTEGER NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL,
 visibility TEXT NOT NULL CHECK(visibility IN ('public','private')),
 owner_id TEXT NOT NULL REFERENCES users(id), entrypoint TEXT NOT NULL, license TEXT NOT NULL,
 forgejo_owner TEXT NOT NULL, forgejo_repo TEXT NOT NULL, forgejo_id INTEGER NOT NULL UNIQUE,
 UNIQUE(forgejo_owner, forgejo_repo)
);
