ALTER TABLE locations ADD COLUMN use_for_requests INTEGER NOT NULL DEFAULT 1 CHECK(use_for_requests IN (0,1));

CREATE TABLE removed_locations (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  lat REAL NOT NULL CHECK(lat BETWEEN -90 AND 90), lng REAL NOT NULL CHECK(lng BETWEEN -180 AND 180),
  label TEXT NOT NULL, removed_at TEXT NOT NULL
);
CREATE INDEX removed_locations_owner ON removed_locations(owner,removed_at);
