ALTER TABLE operations ADD COLUMN ai_frozen INTEGER NOT NULL DEFAULT 1 CHECK(ai_frozen IN (0,1));
ALTER TABLE parks ADD COLUMN city_maintained INTEGER NOT NULL DEFAULT 0 CHECK(city_maintained IN (0,1));
