import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEvents, testFailure } from '../src/drivers/ios/record.ts';

const start = 1_792_000_000;
const marker = (fields: Record<string, unknown>) => `DOOMSHIP ${JSON.stringify(fields)}`;

test('parseEvents: markers become seconds into the video, in order', () => {
  const log = [
    'Test Case started.',
    marker({ event: 'begin', t: start + 11.5, w: 402, h: 874 }),
    `    t =    12.00s ${marker({ event: 'caption', t: start + 11.6, text: 'Welcome' })}`,
    marker({ event: 'tap', t: start + 13.25, t0: start + 13.0, x: 201, y: 799 }),
    marker({ event: 'hook', t: start + 14, text: 'old' }),
    'DOOMSHIP {not json',
    marker({ event: 'end', t: start + 15.0004 }),
  ].join('\n');
  assert.deepEqual(parseEvents(log, start), {
    videoStart: start,
    events: [
      { event: 'begin', t: 11.5, w: 402, h: 874 },
      { event: 'caption', t: 11.6, text: 'Welcome' },
      { event: 'tap', t: 13.25, t0: 13, x: 201, y: 799 },
      { event: 'end', t: 15 },
    ],
  });
});

test('parseEvents: a demo without begin or end says what to call', () => {
  assert.throws(() => parseEvents(marker({ event: 'end', t: start + 1 }), start), /never called demo\.begin\(\)/);
  assert.throws(() => parseEvents(marker({ event: 'begin', t: start + 1 }), start), /never called demo\.end\(\)/);
  const backwards = [marker({ event: 'end', t: start + 1 }), marker({ event: 'begin', t: start + 2 })].join('\n');
  assert.throws(() => parseEvents(backwards, start), /end\(\) before demo\.begin\(\)/);
});

test('testFailure: the assertion, its line in demo.swift and the last caption reached', () => {
  const layout = { helperStart: 900, demoStart: 950 };
  const log = [
    marker({ event: 'caption', t: start, text: 'Welcome on a fresh install' }),
    marker({ event: 'caption', t: start + 1, text: 'A short profile about you' }),
    '/src/AppUITests/AppUITests.swift:961: error: -[AppUITests.Doomship testDemo] : XCTAssertTrue failed',
    "Test Case '-[AppUITests.Doomship testDemo]' failed (12.3 seconds).",
  ].join('\n');
  assert.equal(testFailure(log, '/src', 'AppUITests/AppUITests.swift', layout),
    'Test failed: demo.swift:12: XCTAssertTrue failed\nThe last caption reached: "A short profile about you".\n');
  const injectedText = Array.from({ length: 970 }, (_, i) => (i === 960 ? '        XCTAssertTrue(app.buttons["getStartedButton"].waitForExistence(timeout: 10))' : '')).join('\n');
  assert.equal(testFailure(log, '/src', 'AppUITests/AppUITests.swift', layout, injectedText), [
    'Test failed: demo.swift:12: XCTAssertTrue failed',
    '12 |         XCTAssertTrue(app.buttons["getStartedButton"].waitForExistence(timeout: 10))',
    'The last caption reached: "A short profile about you".',
    'The element it waited for never appeared: check the identifier or label against context.md, and that the step before it reached this screen.',
    '',
  ].join('\n'));
  assert.match(testFailure('** TEST EXECUTE FAILED **', '/src', 'x.swift', layout), /^The demo failed without an assertion message\.\nNo caption was reached\.\nThe end of test\.log:\n\*\* TEST EXECUTE FAILED \*\*/);
});
