import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { pilot } from '../config/settings';
import { createSnapshot, restoreSnapshot } from '../scripts/snapshot.mjs';
import { seedDataset } from '../scripts/fixtures.mjs';
import { applyMigrations, database } from './database';

it('upgrades a populated pre-catalog D1 without changing references or classification',async()=>{
  const proxy=await database(5);
  const db=proxy.env.DB;
  try {
    await seedDataset(db);
    await db.batch([
      db.prepare(`INSERT INTO user(id,name,email,createdAt,updatedAt,role,purpose)
        VALUES ('resident-a','Synthetic resident','resident-a@test.example','2026-01-01','2026-01-01','resident',NULL),
        ('resident-test','Synthetic automated resident','resident-test@test.example','2026-01-01','2026-01-01','resident','automated-test')`),
      db.prepare(`INSERT INTO demand(id,owner,category,lat,lng,status,created_at,confirmed_at) VALUES
        ('original-request','resident-a','sit-up',?,?,'recorded','2026-01-01','2026-01-01'),
        ('test-request','resident-test','parallel',?,?,'recorded','2026-01-01','2026-01-01')`)
        .bind(pilot.center.lat,pilot.center.lng,pilot.center.lat,pilot.center.lng),
    ]);
    const tables=['equipment','candidates','demand','synthetic_demand','user'];
    const selections=tables.map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY id`));
    const before=(await db.batch(selections)).map(entry=>entry.results);
    await applyMigrations(db,5,6);
    expect((await db.batch(selections)).map(entry=>entry.results)).toEqual(before);
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    const types=(await db.prepare('SELECT id,name FROM equipment_types ORDER BY id').all()).results;
    expect(types).toEqual([{id:'parallel',name:'Parallel bars'},{id:'pull-up',name:'Pull-up bars'},{id:'sit-up',name:'Sit-up benches'}]);
    await db.prepare("UPDATE equipment_types SET name='Parallel exercise bars',name_key='parallel exercise bars' WHERE id='parallel'").run();
    await seedDataset(db);
    expect(await db.prepare("SELECT name FROM equipment_types WHERE id='parallel'").first('name')).toBe('Parallel exercise bars');
    await expect(db.prepare("INSERT INTO synthetic_demand VALUES('unknown','unmapped',40.7,-73.8)").run()).rejects.toThrow('FOREIGN KEY');
  } finally {await proxy.dispose();}
});

it('stops and rolls back an upgrade if a legacy database has unmapped IDs',()=>{
  const sqlite=new DatabaseSync(':memory:');
  try {
    const files=readdirSync('migrations').filter(value=>value.endsWith('.sql')).sort();
    for(const file of files.slice(0,5))sqlite.exec(readFileSync('migrations/'+file,'utf8'));
    sqlite.exec("PRAGMA ignore_check_constraints=ON; INSERT INTO synthetic_demand VALUES('legacy-extra','unmapped',40.7,-73.8); PRAGMA ignore_check_constraints=OFF;");
    sqlite.exec('BEGIN');
    expect(()=>sqlite.exec(readFileSync('migrations/'+files[5],'utf8'))).toThrow('unmapped_legacy_equipment_types');
    sqlite.exec('ROLLBACK');
    expect(sqlite.prepare('SELECT category FROM synthetic_demand').get()).toMatchObject({category:'unmapped'});
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name='equipment_types'").get()).toBeUndefined();
  } finally {sqlite.close();}
});

it('restores changed catalog labels and pending intents in private backups, and accepts a 0.2.2 backup',async()=>{
  const source=await database();
  const target=await database();
  const legacy=await database();
  const db=source.env.DB;
  try {
    await seedDataset(db);
    const baseline=await createSnapshot(db,'demo');
    const {equipment_types,type_proposals,...records}=baseline.records;
    records.candidates=records.candidates.map(({estimated_start,estimated_ready,...row})=>row);
    await restoreSnapshot(legacy.env.DB,{...baseline,migration:'0005_resident_travel.sql',version:'0.2.2',records});
    expect((await legacy.env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    await db.batch([
      db.prepare("UPDATE equipment_types SET name='Pull-up stations',name_key='pull-up stations',version=2,active=0 WHERE id='pull-up'"),
      db.prepare(`INSERT INTO user(id,name,email,createdAt,updatedAt,role)
        VALUES('snapshot-owner','Synthetic snapshot resident','snapshot@test.example','2026-01-01','2026-01-01','resident')`),
      db.prepare(`INSERT INTO type_proposals(id,owner,name,name_key,submitted_at,submission_key,lat,lng,note,suggestion)
        VALUES('snapshot-proposal','snapshot-owner','Step apparatus','step apparatus','2026-11-18','fixture-submission',40.72,-73.85,'','')`),
    ]);
    const snapshot=await createSnapshot(db,'private');
    expect((await createSnapshot(db,'demo')).records).not.toHaveProperty('type_proposals');
    await restoreSnapshot(target.env.DB,snapshot);
    const restored=await createSnapshot(target.env.DB,'private');
    expect(restored.records.equipment_types).toEqual(snapshot.records.equipment_types);
    expect(restored.records.type_proposals).toEqual(snapshot.records.type_proposals);
    expect((await target.env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  } finally {await Promise.all([source.dispose(),target.dispose(),legacy.dispose()]);}
});
