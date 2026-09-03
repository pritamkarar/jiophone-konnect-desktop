const test = require('node:test');
const assert = require('node:assert');
const { recentlyDialled, SPEED_DIAL_SLOTS } = require('../src/shared/speeddial');

// Rows as listCalls() returns them: newest first.
const out = (n) => ({ direction: 'out', number_e164: n });
const inc = (n) => ({ direction: 'in', number_e164: n });
const nums = (rows) => recentlyDialled(rows).map((r) => r.number_e164);

test('keeps only outgoing calls', () => {
  assert.deepStrictEqual(nums([inc('+911'), out('+912'), inc('+913')]), ['+912']);
});

test('a redialled number takes one slot, not several', () => {
  assert.deepStrictEqual(
    nums([out('+911'), out('+911'), out('+911'), out('+912')]),
    ['+911', '+912']
  );
});

test('keeps recency order and stops at the slot count', () => {
  const rows = ['+911', '+912', '+913', '+914', '+915'].map(out);
  assert.deepStrictEqual(nums(rows), ['+911', '+912', '+913', '+914']);
  assert.strictEqual(SPEED_DIAL_SLOTS, 4);
});

test('anonymous and empty numbers never earn a slot', () => {
  assert.deepStrictEqual(
    nums([out('unknown'), out(''), out(null), out('+911')]),
    ['+911']
  );
});

test('an empty or missing log draws nothing', () => {
  assert.deepStrictEqual(recentlyDialled([]), []);
  assert.deepStrictEqual(recentlyDialled(undefined), []);
});

test('returns the most recent row for a number, so its name is current', () => {
  const [pick] = recentlyDialled([
    { direction: 'out', number_e164: '+911', name: 'Asha' },
    { direction: 'out', number_e164: '+911', name: null },
  ]);
  assert.strictEqual(pick.name, 'Asha');
});

// The tray menu asks for five, the dial strip for four - the cap is a
// parameter, and it counts DISTINCT numbers: a log whose newest rows are one
// number redialled must still fill the menu.
test('honours a caller-supplied slot count, counting distinct numbers', () => {
  const rows = [out('+911'), out('+911'),
    ...['+912', '+913', '+914', '+915', '+916'].map(out)];
  assert.deepStrictEqual(
    recentlyDialled(rows, 5).map((r) => r.number_e164),
    ['+911', '+912', '+913', '+914', '+915']
  );
});
