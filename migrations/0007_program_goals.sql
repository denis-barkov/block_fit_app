ALTER TABLE candidates ADD COLUMN estimated_start TEXT;
ALTER TABLE candidates ADD COLUMN estimated_ready TEXT;

CREATE TABLE program_goals (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  earliest_start TEXT,
  target_completion TEXT,
  allowed_types TEXT NOT NULL CHECK(json_valid(allowed_types) AND json_type(allowed_types)='array'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  deleted_at TEXT,
  CHECK(earliest_start IS NULL OR target_completion IS NULL OR earliest_start<=target_completion)
);
CREATE INDEX program_goals_active ON program_goals(name,id) WHERE deleted_at IS NULL;

ALTER TABLE ai_jobs ADD COLUMN staff_scope TEXT;
CREATE TABLE ai_staff_usage (
  scope TEXT PRIMARY KEY,
  started INTEGER NOT NULL,
  pending_until INTEGER NOT NULL,
  job_key TEXT NOT NULL
);
CREATE INDEX ai_staff_usage_started ON ai_staff_usage(started);
CREATE TRIGGER ai_staff_reserve AFTER INSERT ON ai_jobs WHEN NEW.staff_scope IS NOT NULL
BEGIN
  INSERT INTO ai_staff_usage(scope,started,pending_until,job_key)
    VALUES(NEW.staff_scope,NEW.started,NEW.expires,NEW.key)
  ON CONFLICT(scope) DO UPDATE SET started=excluded.started,pending_until=excluded.pending_until,job_key=excluded.job_key;
END;
