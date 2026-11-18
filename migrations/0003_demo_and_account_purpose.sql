ALTER TABLE user ADD COLUMN purpose TEXT CHECK(purpose IN ('presentation','automated-test'));
ALTER TABLE parks ADD COLUMN fixture INTEGER NOT NULL DEFAULT 0 CHECK(fixture IN (0,1));
ALTER TABLE equipment ADD COLUMN fixture INTEGER NOT NULL DEFAULT 0 CHECK(fixture IN (0,1));
ALTER TABLE candidates ADD COLUMN fixture INTEGER NOT NULL DEFAULT 0 CHECK(fixture IN (0,1));
ALTER TABLE operations ADD COLUMN demo_version INTEGER NOT NULL DEFAULT 0;

UPDATE parks SET fixture=1 WHERE id IN ('demo-west','demo-east');
UPDATE equipment SET fixture=1 WHERE id IN ('demo-bars','demo-parallel','demo-bench');
UPDATE candidates SET fixture=1 WHERE id IN ('demo-a','demo-b','demo-c');
UPDATE operations SET demo_version=1 WHERE EXISTS (SELECT 1 FROM synthetic_demand);

ALTER TABLE operations ADD COLUMN test_revision INTEGER NOT NULL DEFAULT 0;
DROP TRIGGER revision_demand_INSERT;
DROP TRIGGER revision_demand_UPDATE;
DROP TRIGGER revision_demand_DELETE;
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
