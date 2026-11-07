import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasStartupBuffer } from '../src/lib/playbackBuffer.ts';
const ranges = (...values) => ({ length: values.length, start: (i) => values[i][0], end: (i) => values[i][1] });
test('unknown readiness uses buffered ranges as a conservative fallback', () => {
  assert.equal(hasStartupBuffer(ranges([0, 0.04]), 0, 60), false);
  assert.equal(hasStartupBuffer(ranges([0, 0.75]), 0, 60), true);
  assert.equal(hasStartupBuffer(ranges([0, 5.1]), 5, 60), false);
  assert.equal(hasStartupBuffer(ranges([0, 5.8]), 5, 60), true);
});
test('buffer checks the seek position and does not demand data beyond the end', () => {
  assert.equal(hasStartupBuffer(ranges([0, 2], [5, 6]), 4, 60), false);
  assert.equal(hasStartupBuffer(ranges([0, 2], [5, 6]), 5, 60), true);
  assert.equal(hasStartupBuffer(ranges([9.5, 10]), 9.8, 10), true);
  assert.equal(hasStartupBuffer(ranges(), 0, 10), false);
});

test('future-data readiness never deadlocks demand loading behind a prebuffer threshold', () => {
  const short = ranges([0, 0.428]);
  assert.equal(hasStartupBuffer(short, 0, 60, { readyState: 4, networkState: 1 }), true);
  assert.equal(hasStartupBuffer(short, 0, 60, { readyState: 4, networkState: 2 }), true);
  assert.equal(hasStartupBuffer(short, 0, 60, { readyState: 3, networkState: 1 }), true);
  assert.equal(hasStartupBuffer(short, 0, 60, { readyState: 3, networkState: 2 }), true);
  assert.equal(hasStartupBuffer(ranges([0, 0.04]), 0, 60, { readyState: 3, networkState: 2 }), true, 'play can drive loading while the decoder barrier holds peers');
  assert.equal(hasStartupBuffer(ranges([1 / 24, 0.5]), 0, 60, { readyState: 3, networkState: 2 }), true, 'native future-frame readiness wins over one-frame buffered-range rounding');
  assert.equal(hasStartupBuffer(ranges([0, 14]), 0, 14, { readyState: 2, networkState: 2 }), false, 'buffered bytes do not replace future-frame readiness');
});
