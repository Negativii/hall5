import test from 'node:test';
import assert from 'node:assert/strict';
import { synchronizationPlan } from '../src/lib/playbackSync.ts';

test('a slow startup clock holds leaders without rewinding or seeking the laggard', () => {
  const plan = synchronizationPlan([0.3, 0.31, 0], [false, false, false], true);
  assert.equal(plan.time, 0);
  assert.deepEqual(plan.hold, [true, true, false]);
  assert.deepEqual(plan.resume, [false, false, false]);
  assert.equal(plan.rates[2], 1);
  assert.equal(plan.aligned, false);
});

test('held leaders resume with hysteresis once the slowest clock catches up', () => {
  const waiting = synchronizationPlan([0.3, 0.25], [true, false], true);
  assert.deepEqual(waiting.resume, [false, false]);
  const caughtUp = synchronizationPlan([0.3, 0.28], [true, false], true);
  assert.deepEqual(caughtUp.resume, [true, false]);
  assert.equal(caughtUp.aligned, true);
});

test('normal drift correction slows leaders and holds large runtime drift independent of track order', () => {
  const plan = synchronizationPlan([2.0, 2.1, 2.3], [false, false, false], false);
  assert.deepEqual(plan.hold, [false, false, true]);
  assert.equal(plan.rates[0], 1);
  assert.ok(plan.rates[1] < 1);
  const reordered = synchronizationPlan([2.3, 2, 2.1], [false, false, false], false);
  assert.equal(reordered.time, plan.time);
  assert.deepEqual(reordered.hold, [true, false, false]);
});
