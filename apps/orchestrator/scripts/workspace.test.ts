/**
 * Tests for the sticky-note PATCH validation (see routes/classroom.ts).
 *
 * The gap this locks down: the route used to forward `request.body` straight
 * into `updateStickyNote`, whose `Object.assign` writes whatever keys arrive.
 * A note is then rebroadcast to the whole room as authoritative, so one
 * crafted request could forge votes, force a status, or rewrite the author.
 *
 * Run with: node --import tsx scripts/workspace.test.ts
 */

import assert from 'node:assert/strict';
import { stickyNotePatch } from './../src/routes/classroom.ts';

let pass = 0;
const t = (name: string, fn: () => void): void => {
  try { fn(); pass += 1; console.log(`  ok  ${name}`); }
  catch (e) { console.log(`  FAIL ${name}: ${(e as Error).message}`); process.exitCode = 1; }
};

t('an ordinary edit passes through untouched', () => {
  const parsed = stickyNotePatch.parse({ content: 'Rephrased doubt', color: 'coral' });
  assert.deepEqual(parsed, { content: 'Rephrased doubt', color: 'coral' });
});

t('vote forging is stripped, not applied', () => {
  const parsed = stickyNotePatch.parse({
    content: 'Fine',
    votes: 9_999,
    votedBy: ['teacher', 'teacher', 'teacher'],
  });
  assert.equal('votes' in parsed, false, 'votes belong to the /vote route');
  assert.equal('votedBy' in parsed, false);
  assert.deepEqual(Object.keys(parsed), ['content']);
});

t('status, author, and id cannot be patched', () => {
  const parsed = stickyNotePatch.parse({
    status: 'resolved',
    resolvedAt: 1,
    authorRole: 'teacher',
    authorName: 'Someone Else',
    id: 'sticky-other',
    timestamp: 0,
  });
  assert.deepEqual(parsed, {}, 'nothing on this list is patchable');
});

t('an unknown field is dropped', () => {
  const parsed = stickyNotePatch.parse({ isHeldBackDoubt: false, restraintScore: 0 });
  assert.deepEqual(parsed, {});
});

t('a bad enum value is rejected, not stored', () => {
  assert.throws(() => stickyNotePatch.parse({ color: 'rainbow' }));
  assert.throws(() => stickyNotePatch.parse({ category: 'homework' }));
});

t('blank content is rejected', () => {
  assert.throws(() => stickyNotePatch.parse({ content: '' }));
});

t('a non-object body is rejected', () => {
  assert.throws(() => stickyNotePatch.parse('content'));
  assert.throws(() => stickyNotePatch.parse(null));
});

console.log(`\n${pass} passing`);
