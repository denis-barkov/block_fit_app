import { expect, it } from 'vitest';
import { demoGoalSchedule } from '../config/demo';
import { seedDataset, seedLocalGoals } from '../scripts/fixtures.mjs';
import { createSnapshot, restoreSnapshot } from '../scripts/snapshot.mjs';
import { applyMigrations, database } from './database';

it('upgrades populated catalog D1 and preserves edited and deleted goal fixtures',async()=>{
  const old=await database(6);
  const restored=await database();
  const legacy=await database();
  const {DB:db}=old.env;
  const local={DEPLOYMENT:'local'};
  try {
    await seedDataset(db);
    await db.prepare("UPDATE candidates SET notes='Staff-edited original fixture' WHERE id='demo-b'").run();
    await db.prepare('UPDATE ai_total SET spent=456 WHERE id=1').run();
    const original=(await db.prepare('SELECT * FROM candidates ORDER BY id').all()).results;
    await applyMigrations(db,6);
    const migrated=(await db.prepare('SELECT * FROM candidates ORDER BY id').all()).results;
    expect(migrated.map(({estimated_start,estimated_ready,...candidate})=>candidate)).toEqual(original);
    expect(migrated.every(row=>row.estimated_start===null&&row.estimated_ready===null)).toBe(true);
    expect(await db.prepare('SELECT spent FROM ai_total').first('spent')).toBe(456);

    const oldFormat=await createSnapshot(db,'private');
    delete oldFormat.records.program_goals;
    oldFormat.records.candidates=oldFormat.records.candidates.map(({estimated_start,estimated_ready,...row})=>row);
    await restoreSnapshot(legacy.env.DB,{...oldFormat,version:'0.3.0',migration:'0006_equipment_catalog.sql'});
    expect((await legacy.env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);

    await seedLocalGoals(db,local);
    expect(await db.prepare("SELECT estimated_start FROM candidates WHERE id='demo-a'").first('estimated_start')).toBe(demoGoalSchedule.earliestStart);
    expect(await db.prepare("SELECT notes,estimated_ready FROM candidates WHERE id='demo-b'").first()).toEqual({
      notes:'Staff-edited original fixture',estimated_ready:null,
    });
    await db.batch([
      db.prepare("UPDATE program_goals SET name='Staff changed demo goal' WHERE id='demo-goal-low-disruption'"),
      db.prepare("UPDATE program_goals SET deleted_at='2026-11-18' WHERE id='demo-goal-delivery'"),
      db.prepare("UPDATE candidates SET notes='Staff changed seeded schedule note' WHERE id='demo-a'"),
    ]);
    await seedLocalGoals(db,local);
    expect(await db.prepare('SELECT count(*) FROM program_goals WHERE deleted_at IS NULL').first('count(*)')).toBe(2);
    expect(await db.prepare("SELECT name FROM program_goals WHERE id='demo-goal-low-disruption'").first('name')).toBe('Staff changed demo goal');
    expect(await db.prepare("SELECT notes FROM candidates WHERE id='demo-a'").first('notes')).toBe('Staff changed seeded schedule note');
    const snapshot=await createSnapshot(db,'private');
    expect((await createSnapshot(db,'demo')).records).not.toHaveProperty('program_goals');
    await restoreSnapshot(restored.env.DB,snapshot);
    const roundTrip=await createSnapshot(restored.env.DB,'private');
    expect(roundTrip.records.program_goals).toEqual(snapshot.records.program_goals);
    expect(roundTrip.records.candidates).toEqual(snapshot.records.candidates);
    expect(roundTrip.spent).toBe(456);
  } finally {await Promise.all([old.dispose(),legacy.dispose(),restored.dispose()]);}
});
