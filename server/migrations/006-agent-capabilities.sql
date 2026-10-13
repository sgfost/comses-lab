ALTER TABLE agent_grants ADD COLUMN allow_create INTEGER NOT NULL DEFAULT 0 CHECK(allow_create IN (0,1));
