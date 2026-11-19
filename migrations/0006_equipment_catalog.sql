-- Preserve legacy keys and use catalog foreign keys for every type reference.
CREATE TABLE equipment_types (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0)
);
INSERT INTO equipment_types(id,name,name_key,created_at,updated_at)
SELECT column1,column2,lower(column2),strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM (VALUES ('pull-up','Pull-up bars'),('parallel','Parallel bars'),('sit-up','Sit-up benches'));

CREATE TABLE catalog_migration_guard (unmapped_legacy_equipment_types INTEGER CHECK(unmapped_legacy_equipment_types=0));
INSERT INTO catalog_migration_guard
SELECT count(*) FROM (
  SELECT category FROM demand UNION SELECT category FROM synthetic_demand
  UNION SELECT category FROM equipment UNION SELECT category FROM candidates
) WHERE category NOT IN (SELECT id FROM equipment_types);
DROP TABLE catalog_migration_guard;

DROP TRIGGER move_active_demand;

CREATE TABLE demand_catalog (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  category TEXT NOT NULL REFERENCES equipment_types(id),
  lat REAL NOT NULL CHECK(lat BETWEEN -90 AND 90), lng REAL NOT NULL CHECK(lng BETWEEN -180 AND 180),
  status TEXT NOT NULL CHECK(status IN ('recorded','withdrawn')),
  note TEXT NOT NULL DEFAULT '', suggestion TEXT NOT NULL DEFAULT '', suggested_lat REAL, suggested_lng REAL,
  created_at TEXT NOT NULL, confirmed_at TEXT NOT NULL
);
INSERT INTO demand_catalog SELECT * FROM demand;
DROP TABLE demand;
ALTER TABLE demand_catalog RENAME TO demand;

CREATE UNIQUE INDEX demand_active ON demand(owner,category) WHERE status='recorded';

CREATE INDEX demand_owner_history ON demand(owner,created_at DESC);

CREATE INDEX demand_category_status ON demand(category,status);

CREATE TRIGGER revision_demand_INSERT AFTER INSERT ON demand BEGIN
  UPDATE revision SET value=value+1 WHERE id=1 AND NOT EXISTS(SELECT 1 FROM user WHERE id=NEW.owner AND purpose='automated-test');
  UPDATE operations SET test_revision=test_revision+1 WHERE id=1 AND EXISTS(SELECT 1 FROM user WHERE id=NEW.owner AND purpose='automated-test');
END;

CREATE TRIGGER revision_demand_UPDATE AFTER UPDATE ON demand BEGIN
  UPDATE revision SET value=value+1 WHERE id=1 AND NOT EXISTS(SELECT 1 FROM user WHERE id=NEW.owner AND purpose='automated-test');
  UPDATE operations SET test_revision=test_revision+1 WHERE id=1 AND EXISTS(SELECT 1 FROM user WHERE id=NEW.owner AND purpose='automated-test');
END;

CREATE TRIGGER revision_demand_DELETE AFTER DELETE ON demand BEGIN
  UPDATE revision SET value=value+1 WHERE id=1 AND NOT EXISTS(SELECT 1 FROM user WHERE id=OLD.owner AND purpose='automated-test');
  UPDATE operations SET test_revision=test_revision+1 WHERE id=1 AND EXISTS(SELECT 1 FROM user WHERE id=OLD.owner AND purpose='automated-test');
END;

CREATE TABLE synthetic_demand_catalog (
  id TEXT PRIMARY KEY, category TEXT NOT NULL REFERENCES equipment_types(id),
  lat REAL NOT NULL CHECK(lat BETWEEN -90 AND 90), lng REAL NOT NULL CHECK(lng BETWEEN -180 AND 180)
);
INSERT INTO synthetic_demand_catalog SELECT * FROM synthetic_demand;
DROP TABLE synthetic_demand;
ALTER TABLE synthetic_demand_catalog RENAME TO synthetic_demand;

CREATE INDEX synthetic_category ON synthetic_demand(category);

CREATE TRIGGER revision_synthetic_demand_INSERT AFTER INSERT ON synthetic_demand BEGIN UPDATE revision SET value=value+1 WHERE id=1; END;

CREATE TRIGGER revision_synthetic_demand_UPDATE AFTER UPDATE ON synthetic_demand BEGIN UPDATE revision SET value=value+1 WHERE id=1; END;

CREATE TRIGGER revision_synthetic_demand_DELETE AFTER DELETE ON synthetic_demand BEGIN UPDATE revision SET value=value+1 WHERE id=1; END;

CREATE TABLE equipment_catalog (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL REFERENCES equipment_types(id),
  lat REAL NOT NULL, lng REAL NOT NULL, park_id TEXT REFERENCES parks(id),
  condition TEXT NOT NULL CHECK(condition IN ('unknown','usable','unusable')),
  access TEXT NOT NULL CHECK(access IN ('unknown','public','restricted')),
  source TEXT NOT NULL, verified_on TEXT, visible INTEGER NOT NULL CHECK(visible IN (0,1)),
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
  fixture INTEGER NOT NULL DEFAULT 0 CHECK(fixture IN (0,1))
);
INSERT INTO equipment_catalog SELECT * FROM equipment;
DROP TABLE equipment;
ALTER TABLE equipment_catalog RENAME TO equipment;

CREATE INDEX equipment_public ON equipment(archived,visible,category);

CREATE TRIGGER revision_equipment_INSERT AFTER INSERT ON equipment BEGIN UPDATE revision SET value=value+1 WHERE id=1; END;

CREATE TRIGGER revision_equipment_UPDATE AFTER UPDATE ON equipment BEGIN UPDATE revision SET value=value+1 WHERE id=1; END;

CREATE TRIGGER revision_equipment_DELETE AFTER DELETE ON equipment BEGIN UPDATE revision SET value=value+1 WHERE id=1; END;

CREATE TABLE candidates_catalog (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL REFERENCES equipment_types(id),
  lat REAL NOT NULL, lng REAL NOT NULL, park_id TEXT REFERENCES parks(id),
  feasibility TEXT NOT NULL CHECK(feasibility IN ('unreviewed','suitable-for-comparison','excluded')),
  costs TEXT NOT NULL CHECK(json_valid(costs)), notes TEXT NOT NULL, project_url TEXT,
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
  fixture INTEGER NOT NULL DEFAULT 0 CHECK(fixture IN (0,1))
);
INSERT INTO candidates_catalog SELECT * FROM candidates;
DROP TABLE candidates;
ALTER TABLE candidates_catalog RENAME TO candidates;

CREATE INDEX candidates_category ON candidates(category,archived);

CREATE TRIGGER revision_candidates_INSERT AFTER INSERT ON candidates BEGIN UPDATE revision SET value=value+1 WHERE id=1; END;

CREATE TRIGGER revision_candidates_UPDATE AFTER UPDATE ON candidates BEGIN UPDATE revision SET value=value+1 WHERE id=1; END;

CREATE TRIGGER revision_candidates_DELETE AFTER DELETE ON candidates BEGIN UPDATE revision SET value=value+1 WHERE id=1; END;

CREATE TRIGGER move_active_demand AFTER UPDATE OF lat,lng ON locations
WHEN NEW.lat IS NOT OLD.lat OR NEW.lng IS NOT OLD.lng
BEGIN
  UPDATE demand SET lat=NEW.lat,lng=NEW.lng WHERE owner=NEW.owner AND status='recorded';
END;

CREATE TRIGGER revision_type_insert AFTER INSERT ON equipment_types
BEGIN UPDATE revision SET value=value+1 WHERE id=1; END;
CREATE TRIGGER revision_type_update AFTER UPDATE ON equipment_types
BEGIN UPDATE revision SET value=value+1 WHERE id=1; END;
UPDATE revision SET value=value+1 WHERE id=1;

-- Pending intents live here until review. Their private fields are cleared once decided.
CREATE TABLE type_proposals (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  submitted_at TEXT NOT NULL,
  submission_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','withdrawn')),
  reviewer TEXT REFERENCES user(id) ON DELETE SET NULL,
  decided_at TEXT,
  category TEXT REFERENCES equipment_types(id),
  reason TEXT,
  request_id TEXT REFERENCES demand(id) ON DELETE SET NULL,
  reused_request INTEGER NOT NULL DEFAULT 0 CHECK(reused_request IN (0,1)),
  lat REAL CHECK(lat BETWEEN -90 AND 90),
  lng REAL CHECK(lng BETWEEN -180 AND 180),
  note TEXT,
  suggestion TEXT,
  suggested_lat REAL,
  suggested_lng REAL,
  UNIQUE(owner,submission_key),
  CHECK(status<>'pending' OR (lat IS NOT NULL AND lng IS NOT NULL AND note IS NOT NULL AND suggestion IS NOT NULL))
);
CREATE UNIQUE INDEX proposals_pending_name ON type_proposals(owner,name_key) WHERE status='pending';
CREATE INDEX proposals_owner_date ON type_proposals(owner,submitted_at DESC);
CREATE INDEX proposals_queue ON type_proposals(status,submitted_at DESC);
CREATE INDEX proposals_reviewer ON type_proposals(reviewer) WHERE reviewer IS NOT NULL;
CREATE INDEX proposals_request ON type_proposals(request_id) WHERE request_id IS NOT NULL;
