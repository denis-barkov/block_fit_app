-- Retain historical ledger values for existing snapshots. New requests only track timing.
DROP TRIGGER ai_reserve;
DROP TRIGGER ai_reconcile;
DROP TRIGGER ai_resident_reserve;

CREATE TRIGGER ai_resident_reserve AFTER INSERT ON ai_jobs WHEN NEW.resident_scope IS NOT NULL
BEGIN
  INSERT INTO ai_resident_usage(scope,day,attempts,started,pending_until,job_key)
    VALUES(NEW.resident_scope,NEW.day,0,NEW.started,NEW.expires,NEW.key)
  ON CONFLICT(scope) DO UPDATE SET started=excluded.started,pending_until=excluded.pending_until,job_key=excluded.job_key;
END;
