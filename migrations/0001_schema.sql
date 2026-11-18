CREATE TABLE user (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  emailVerified INTEGER NOT NULL DEFAULT 0, image TEXT,
  createdAt DATETIME NOT NULL, updatedAt DATETIME NOT NULL,
  role TEXT NOT NULL DEFAULT 'resident' CHECK(role IN ('resident','staff')),
  banned INTEGER DEFAULT 0, banReason TEXT, banExpires DATETIME
);
CREATE TABLE session (
  id TEXT PRIMARY KEY, expiresAt DATETIME NOT NULL, token TEXT NOT NULL UNIQUE,
  createdAt DATETIME NOT NULL, updatedAt DATETIME NOT NULL, ipAddress TEXT, userAgent TEXT,
  userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE, impersonatedBy TEXT
);
CREATE INDEX session_user ON session(userId);
CREATE TABLE account (
  id TEXT PRIMARY KEY, accountId TEXT NOT NULL, providerId TEXT NOT NULL,
  userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  accessToken TEXT, refreshToken TEXT, idToken TEXT, accessTokenExpiresAt DATETIME,
  refreshTokenExpiresAt DATETIME, scope TEXT, password TEXT,
  createdAt DATETIME NOT NULL, updatedAt DATETIME NOT NULL,
  UNIQUE(providerId, accountId)
);
CREATE INDEX account_user ON account(userId);
CREATE TABLE verification (
  id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL,
  expiresAt DATETIME NOT NULL, createdAt DATETIME NOT NULL, updatedAt DATETIME NOT NULL
);
CREATE INDEX verification_identifier ON verification(identifier);
CREATE TABLE throttle (key TEXT PRIMARY KEY, window INTEGER NOT NULL, attempts INTEGER NOT NULL);
CREATE INDEX throttle_window ON throttle(window);

CREATE TABLE locations (
  owner TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  lat REAL NOT NULL CHECK(lat BETWEEN -90 AND 90), lng REAL NOT NULL CHECK(lng BETWEEN -180 AND 180),
  label TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
);
CREATE TABLE demand (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK(category IN ('pull-up','parallel','sit-up')),
  lat REAL NOT NULL CHECK(lat BETWEEN -90 AND 90), lng REAL NOT NULL CHECK(lng BETWEEN -180 AND 180),
  status TEXT NOT NULL CHECK(status IN ('recorded','withdrawn')),
  note TEXT NOT NULL DEFAULT '', suggestion TEXT NOT NULL DEFAULT '', suggested_lat REAL, suggested_lng REAL,
  created_at TEXT NOT NULL, confirmed_at TEXT NOT NULL
);
CREATE UNIQUE INDEX demand_active ON demand(owner,category) WHERE status='recorded';
CREATE INDEX demand_owner_history ON demand(owner,created_at DESC);
CREATE INDEX demand_category_status ON demand(category,status);
CREATE TABLE synthetic_demand (
  id TEXT PRIMARY KEY, category TEXT NOT NULL CHECK(category IN ('pull-up','parallel','sit-up')),
  lat REAL NOT NULL CHECK(lat BETWEEN -90 AND 90), lng REAL NOT NULL CHECK(lng BETWEEN -180 AND 180)
);
CREATE INDEX synthetic_category ON synthetic_demand(category);

CREATE TABLE parks (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL,
  external_id TEXT NOT NULL, source TEXT NOT NULL, hours TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1))
);
CREATE TABLE equipment (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL CHECK(category IN ('pull-up','parallel','sit-up')),
  lat REAL NOT NULL, lng REAL NOT NULL, park_id TEXT REFERENCES parks(id),
  condition TEXT NOT NULL CHECK(condition IN ('unknown','usable','unusable')),
  access TEXT NOT NULL CHECK(access IN ('unknown','public','restricted')),
  source TEXT NOT NULL, verified_on TEXT, visible INTEGER NOT NULL CHECK(visible IN (0,1)),
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1))
);
CREATE INDEX equipment_public ON equipment(archived,visible,category);
CREATE TABLE candidates (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL CHECK(category IN ('pull-up','parallel','sit-up')),
  lat REAL NOT NULL, lng REAL NOT NULL, park_id TEXT REFERENCES parks(id),
  feasibility TEXT NOT NULL CHECK(feasibility IN ('unreviewed','suitable-for-comparison','excluded')),
  costs TEXT NOT NULL CHECK(json_valid(costs)), notes TEXT NOT NULL, project_url TEXT,
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1))
);
CREATE INDEX candidates_category ON candidates(category,archived);

CREATE TABLE revision (id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL);
INSERT INTO revision VALUES (1,0);
CREATE TRIGGER move_active_demand AFTER UPDATE OF lat,lng ON locations
WHEN NEW.lat IS NOT OLD.lat OR NEW.lng IS NOT OLD.lng
BEGIN
  UPDATE demand SET lat=NEW.lat,lng=NEW.lng WHERE owner=NEW.owner AND status='recorded';
END;

CREATE TABLE ai_total (id INTEGER PRIMARY KEY CHECK(id=1), spent INTEGER NOT NULL CHECK(spent>=0));
INSERT INTO ai_total VALUES (1,0);
CREATE TABLE ai_day (day TEXT PRIMARY KEY, attempts INTEGER NOT NULL);
CREATE TABLE ai_jobs (
  key TEXT PRIMARY KEY, day TEXT NOT NULL, reserved INTEGER NOT NULL CHECK(reserved>=0),
  started INTEGER NOT NULL, expires INTEGER NOT NULL, result TEXT
);
CREATE INDEX ai_jobs_expiry ON ai_jobs(expires);
CREATE TABLE operations (id INTEGER PRIMARY KEY CHECK(id=1), suspended INTEGER NOT NULL DEFAULT 0);
INSERT INTO operations VALUES (1,0);
CREATE TRIGGER revision_demand_INSERT AFTER INSERT ON demand BEGIN UPDATE revision SET value=value+1 WHERE id=1; END;
CREATE TRIGGER revision_demand_UPDATE AFTER UPDATE ON demand BEGIN UPDATE revision SET value=value+1 WHERE id=1; END;
CREATE TRIGGER revision_demand_DELETE AFTER DELETE ON demand BEGIN UPDATE revision SET value=value+1 WHERE id=1; END;
CREATE TRIGGER revision_synthetic_demand_INSERT AFTER INSERT ON synthetic_demand BEGIN UPDATE revision SET value=value+1 WHERE id=1; END;
CREATE TRIGGER revision_synthetic_demand_UPDATE AFTER UPDATE ON synthetic_demand BEGIN UPDATE revision SET value=value+1 WHERE id=1; END;
CREATE TRIGGER revision_synthetic_demand_DELETE AFTER DELETE ON synthetic_demand BEGIN UPDATE revision SET value=value+1 WHERE id=1; END;
CREATE TRIGGER revision_parks_INSERT AFTER INSERT ON parks BEGIN UPDATE revision SET value=value+1 WHERE id=1; END;
CREATE TRIGGER revision_parks_UPDATE AFTER UPDATE ON parks BEGIN UPDATE revision SET value=value+1 WHERE id=1; END;
CREATE TRIGGER revision_parks_DELETE AFTER DELETE ON parks BEGIN UPDATE revision SET value=value+1 WHERE id=1; END;
CREATE TRIGGER revision_equipment_INSERT AFTER INSERT ON equipment BEGIN UPDATE revision SET value=value+1 WHERE id=1; END;
CREATE TRIGGER revision_equipment_UPDATE AFTER UPDATE ON equipment BEGIN UPDATE revision SET value=value+1 WHERE id=1; END;
CREATE TRIGGER revision_equipment_DELETE AFTER DELETE ON equipment BEGIN UPDATE revision SET value=value+1 WHERE id=1; END;
CREATE TRIGGER revision_candidates_INSERT AFTER INSERT ON candidates BEGIN UPDATE revision SET value=value+1 WHERE id=1; END;
CREATE TRIGGER revision_candidates_UPDATE AFTER UPDATE ON candidates BEGIN UPDATE revision SET value=value+1 WHERE id=1; END;
CREATE TRIGGER revision_candidates_DELETE AFTER DELETE ON candidates BEGIN UPDATE revision SET value=value+1 WHERE id=1; END;

CREATE TRIGGER ai_reserve AFTER INSERT ON ai_jobs BEGIN
  UPDATE ai_total SET spent=spent+NEW.reserved WHERE id=1;
  INSERT INTO ai_day(day,attempts) VALUES(NEW.day,1)
    ON CONFLICT(day) DO UPDATE SET attempts=attempts+1;
END;
CREATE TRIGGER ai_reconcile AFTER UPDATE OF reserved ON ai_jobs BEGIN
  UPDATE ai_total SET spent=spent-OLD.reserved+NEW.reserved WHERE id=1;
END;
