ALTER TABLE ai_jobs ADD COLUMN resident_scope TEXT;

CREATE TABLE ai_resident_usage (
  scope TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  attempts INTEGER NOT NULL CHECK(attempts>=0),
  started INTEGER NOT NULL,
  pending_until INTEGER NOT NULL,
  job_key TEXT NOT NULL
);
CREATE INDEX ai_resident_usage_started ON ai_resident_usage(started);
CREATE TRIGGER ai_resident_reserve AFTER INSERT ON ai_jobs WHEN NEW.resident_scope IS NOT NULL
BEGIN
  INSERT INTO ai_resident_usage(scope,day,attempts,started,pending_until,job_key)
    VALUES(NEW.resident_scope,NEW.day,1,NEW.started,NEW.expires,NEW.key)
  ON CONFLICT(scope) DO UPDATE SET attempts=CASE WHEN day=excluded.day THEN attempts+1 ELSE 1 END,
    day=excluded.day,started=excluded.started,pending_until=excluded.pending_until,job_key=excluded.job_key;
END;
