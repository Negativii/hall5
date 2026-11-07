import test from 'node:test';
import assert from 'node:assert/strict';
import { encoderTimeBase } from '../server/mediaTimeBase.js';

test('encoder time base retains exact demuxer precision including fractional-rate inputs', () => {
  for (const timeBase of ['1/12288', '1/15360', '1/90000', '1001/30000']) {
    assert.equal(encoderTimeBase({ timeBase }), timeBase);
  }
});
test('missing, symbolic and invalid time bases fail before encoding', () => {
  for (const timeBase of [undefined, '', 'demux', '0/1', '1/0', '-1/24', '1/2147483648', '1/NaN']) {
    assert.throws(() => encoderTimeBase({ timeBase }), /временную базу/);
  }
});
