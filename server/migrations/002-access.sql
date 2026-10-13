CREATE TABLE groups (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), pending_update_id TEXT
);
CREATE TABLE group_members (
 group_id TEXT NOT NULL REFERENCES groups(id), user_id TEXT NOT NULL REFERENCES users(id),
 permission TEXT NOT NULL CHECK(permission IN ('read','write')), PRIMARY KEY(group_id,user_id)
);
CREATE TABLE project_access (
 project_id TEXT PRIMARY KEY REFERENCES projects(id), version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 group_id TEXT REFERENCES groups(id), pending_update_id TEXT
);
INSERT INTO project_access(project_id) SELECT id FROM projects;
CREATE TABLE access_updates (
 id TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES users(id), request_id TEXT NOT NULL,
 request_hash TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('project','group')),
 target_id TEXT NOT NULL, desired TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','completed')), message TEXT NOT NULL DEFAULT '',
 UNIQUE(actor_id,request_id)
);
CREATE TABLE access_update_projects (
 update_id TEXT NOT NULL REFERENCES access_updates(id), project_id TEXT NOT NULL REFERENCES projects(id),
 provider_id INTEGER NOT NULL, provider_owner TEXT NOT NULL, provider_repo TEXT NOT NULL,
 desired TEXT NOT NULL, confirmed INTEGER NOT NULL DEFAULT 0 CHECK(confirmed IN (0,1)),
 PRIMARY KEY(update_id,project_id)
);
CREATE TABLE managed_collaborators (
 project_id TEXT NOT NULL REFERENCES projects(id), user_id TEXT NOT NULL REFERENCES users(id),
 provider_user_id INTEGER NOT NULL, permission TEXT NOT NULL CHECK(permission IN ('read','write')),
 PRIMARY KEY(project_id,user_id)
);
CREATE TABLE agent_grants (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL,
 token_hash TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL CHECK(state IN ('active','revocation_pending','revoked'))
);
CREATE TABLE agent_project_scopes (
 grant_id TEXT NOT NULL REFERENCES agent_grants(id), project_id TEXT NOT NULL REFERENCES projects(id),
 permission TEXT NOT NULL CHECK(permission IN ('read','write')),
 fork_limit INTEGER NOT NULL DEFAULT 0 CHECK(fork_limit BETWEEN 0 AND 8),
 forks_reserved INTEGER NOT NULL DEFAULT 0 CHECK(forks_reserved>=0),
 source_project_id TEXT REFERENCES projects(id), source_commit TEXT,
 PRIMARY KEY(grant_id,project_id)
);
ALTER TABLE project_provisions ADD COLUMN grant_id TEXT REFERENCES agent_grants(id);
CREATE TABLE agent_git_credentials (
 id TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES agent_grants(id), project_id TEXT NOT NULL REFERENCES projects(id),
 request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
 permission TEXT NOT NULL CHECK(permission IN ('read','write')),
 provider_user_id INTEGER NOT NULL, provider_username TEXT NOT NULL,
 provider_repo_id INTEGER NOT NULL, provider_owner TEXT NOT NULL, provider_repo TEXT NOT NULL,
 reserved_name TEXT NOT NULL UNIQUE, dispatched INTEGER NOT NULL DEFAULT 0 CHECK(dispatched IN (0,1)),
 state TEXT NOT NULL CHECK(state IN ('issuing','active','issuance_unknown','revocation_pending','revoked')),
 operator_required INTEGER NOT NULL DEFAULT 0 CHECK(operator_required IN (0,1)),
 UNIQUE(grant_id,request_id)
);
CREATE TABLE agent_credential_token_ids (
 credential_id TEXT NOT NULL REFERENCES agent_git_credentials(id), provider_token_id INTEGER NOT NULL,
 deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)), PRIMARY KEY(credential_id,provider_token_id)
);
CREATE TABLE credential_recovery (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), grant_id TEXT NOT NULL REFERENCES agent_grants(id),
 stage TEXT NOT NULL, provider_identity TEXT, restarted_at INTEGER
);
CREATE TABLE access_seed (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), group_id TEXT NOT NULL,
 project_id TEXT NOT NULL, stage TEXT NOT NULL
);
