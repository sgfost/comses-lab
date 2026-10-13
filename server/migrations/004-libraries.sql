ALTER TABLE project_metadata ADD COLUMN kind TEXT NOT NULL DEFAULT 'model' CHECK(kind IN ('model','library'));
ALTER TABLE project_metadata ADD COLUMN derivation TEXT NOT NULL DEFAULT 'fork' CHECK(derivation IN ('fork','extraction'));
