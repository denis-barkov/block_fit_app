import { expect, it } from 'vitest';
import { demoGoalSchedule, demoProgramGoals, previousDemoProgramGoals } from '../config/demo';
import { planning } from '../config/settings';
import { seedDataset, seedLocalGoals } from '../scripts/fixtures.mjs';
import { createSnapshot, restoreSnapshot } from '../scripts/snapshot.mjs';
import { goalRows } from '../src/goals';
import { getComparison } from '../src/server/database';
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
    const prior=previousDemoProgramGoals.find(goal=>goal.id==='demo-goal-delivery');
    await db.prepare("UPDATE program_goals SET description=?,target_completion=NULL WHERE id=?")
      .bind('Illustrative demo. '+prior.description,prior.id).run();
    await seedLocalGoals(db,local);
    expect(await db.prepare("SELECT target_completion,version FROM program_goals WHERE id=?").bind(prior.id).first()).toEqual({
      target_completion:demoProgramGoals.find(goal=>goal.id===prior.id).targetCompletion,version:2,
    });
    expect(await db.prepare("SELECT estimated_ready FROM candidates WHERE id='demo-v3-east-gate-candidate'").first('estimated_ready')).toBe('2027-05-06');
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
    await restoreSnapshot(restored.env.DB,{...snapshot,version:'0.4.0'});
    const roundTrip=await createSnapshot(restored.env.DB,'private');
    expect(roundTrip.records.program_goals).toEqual(snapshot.records.program_goals);
    expect(roundTrip.records.candidates).toEqual(snapshot.records.candidates);
    expect(roundTrip.spent).toBe(456);
  } finally {await Promise.all([old.dispose(),legacy.dispose(),restored.dispose()]);}
});

it('expands a v2 demo without rewriting its records and creates contrasting goal evidence',async()=>{
  const proxy=await database();
  const {DB:db}=proxy.env;
  try {
    await seedDataset(db);
    await db.batch([
      ...['equipment','candidates','synthetic_demand','parks'].map(table=>db.prepare(`DELETE FROM ${table} WHERE id LIKE 'demo-v3-%'`)),
      db.prepare('UPDATE operations SET demo_version=2 WHERE id=1'),
      db.prepare("UPDATE candidates SET notes='Preserve this edited site' WHERE id='demo-a'"),
    ]);
    const oldDemand=(await db.prepare('SELECT * FROM synthetic_demand ORDER BY id').all()).results;
    await seedDataset(db,{update:true});
    await seedLocalGoals(db,{DEPLOYMENT:'local'});
    expect((await db.prepare("SELECT * FROM synthetic_demand WHERE id LIKE 'demo-v2-%' ORDER BY id").all()).results).toEqual(oldDemand);
    expect(await db.prepare("SELECT notes FROM candidates WHERE id='demo-a'").first('notes')).toBe('Preserve this edited site');
    const scenario={category:'pull-up',radius:planning.radius,budget:planning.budget,horizon:planning.horizon,selected:[]};
    const comparison=await getComparison(db,scenario);
    const options=new Map(comparison.options.map(option=>[option.ids[0],option]));
    const [disruption,delivery]=demoProgramGoals;
    const rows=goal=>new Map(goalRows(comparison,goal).map(row=>[row.id,row]));
    const westPad='demo-v3-west-pad',westCommons='demo-v3-west-program',eastGate='demo-v3-east-gate-candidate';
    expect(rows(disruption).get(westPad)).toMatchObject({requirement:'meets',eligibility:'meets'});
    expect(rows(delivery).get(westPad)).toMatchObject({requirement:'fails',bucket:'excluded'});
    expect(rows(delivery).get(eastGate)).toMatchObject({requirement:'meets',eligibility:'meets'});
    expect(rows(disruption).get('demo-a')).toMatchObject({requirement:'unknown',bucket:'information'});
    expect(options.get(westCommons).count).toBeGreaterThan(Math.max(options.get('demo-a').count,options.get(eastGate).count,options.get(westPad).count));
    const revision=comparison.revision;
    await seedDataset(db,{update:true});
    await seedLocalGoals(db,{DEPLOYMENT:'local'});
    expect((await getComparison(db,scenario)).revision).toBe(revision);
  } finally {await proxy.dispose();}
});
