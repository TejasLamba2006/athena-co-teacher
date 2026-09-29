/**
 * Tests for the brace control channel (see src/agent/control.ts).
 *
 * These matter more than their size suggests: the parser reads model output, so
 * its failure modes are the model's failure modes — an unbalanced apostrophe in
 * spoken prose, a half-formed object, braces that are genuinely part of what was
 * said. Every case below is one of those, not a happy path.
 *
 * Run with: node --import tsx scripts/control.test.ts
 */

import assert from 'node:assert/strict';
import { parseAgentTurn, matchParticipantByName } from '../src/agent/control.ts';

let pass = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); pass += 1; console.log(`  ok  ${name}`); }
  catch (e) { console.log(`  FAIL ${name}: ${(e as Error).message}`); process.exitCode = 1; }
};

t('plain speech, no payload', () => {
  const r = parseAgentTurn('Think about what the denominator counts.');
  assert.equal(r.spoken, 'Think about what the denominator counts.');
  assert.equal(r.control, null);
});

t('strips a "to" payload', () => {
  const r = parseAgentTurn('Good question, Ana. Halves and thirds are different sizes. {"to":"Ana"}');
  assert.equal(r.spoken, 'Good question, Ana. Halves and thirds are different sizes.');
  assert.equal(r.control?.to, 'Ana');
});

t("apostrophe in prose doesn't hide the JSON", () => {
  const r = parseAgentTurn(`That's why you can't just add them. {"to":"Bilal"}`);
  assert.equal(r.control?.to, 'Bilal');
  assert.ok(!r.spoken.includes('{'));
});

t('reads a quiz payload', () => {
  const r = parseAgentTurn(
    'Quick check. A: add the denominators. B: find the LCD. C: multiply. ' +
    '{"quiz":{"topic":"LCD","question":"What comes first?","options":["Add the denominators","Find the LCD","Multiply"],"answer":"B","difficulty":"easy"}}'
  );
  assert.equal(r.control?.quiz?.answer, 'B');
  assert.equal(r.control?.quiz?.options.length, 3);
  assert.ok(!r.spoken.includes('{'));
});

t('reads a gap payload', () => {
  const r = parseAgentTurn('Let me try that differently. {"to":"Ana","gap":{"topic":"common denominator","students":["Ana","Bilal"]}}');
  assert.equal(r.control?.gap?.students.length, 2);
  assert.equal(r.control?.gap?.topic, 'common denominator');
});

t('empty payload still strips braces', () => {
  const r = parseAgentTurn('Carry on. {}');
  assert.equal(r.spoken, 'Carry on.');
  assert.deepEqual(r.control, {});
});

t('malformed JSON is left alone, never thrown on', () => {
  const r = parseAgentTurn('Hmm {this is not json}');
  assert.equal(r.control, null);
  assert.ok(r.spoken.length > 0);
});

t('a quiz missing required fields is rejected, not half-read', () => {
  const r = parseAgentTurn('Question. {"quiz":{"topic":"x","question":"y"}}');
  assert.equal(r.control?.quiz, undefined);
});

t('math braces in speech do not become a payload', () => {
  const r = parseAgentTurn('The set is {1, 2, 3} as we said.');
  assert.equal(r.control, null);
});

t('name matching is loose', () => {
  const roster = [{ participantId: 'p1', displayName: 'Ana' }, { participantId: 'p2', displayName: 'Bilal' }];
  assert.equal(matchParticipantByName(roster, 'ana'), 'p1');
  assert.equal(matchParticipantByName(roster, 'Bilal '), 'p2');
  assert.equal(matchParticipantByName(roster, 'Nobody'), undefined);
});

t('reads a board write payload', () => {
  const r = parseAgentTurn(
    'Here is the method. {"board":{"action":"write","text":"LCD of 2 and 3 is 6"}}',
  );
  assert.equal(r.control?.board?.action, 'write');
  assert.equal(r.control?.board?.text, 'LCD of 2 and 3 is 6');
  assert.ok(!r.spoken.includes('{'));
});

// ─── quantum circuit payloads (PS 26140) ─────────────────────────────────────
//
// This is the Athena -> screen half of the playground. Everything below is a
// shape the model can actually emit, and a bad one reaching the simulator
// throws inside a live turn — so the parser must reject, never half-read.

t('reads a Bell circuit payload', () => {
  const r = parseAgentTurn(
    'Watch what happens when the Hadamard comes first. ' +
      '{"circuit":{"qubits":2,"gates":[{"gate":"h","qubit":0},{"gate":"cnot","qubit":0,"target":1}]}}',
  );
  assert.equal(r.control?.circuit?.qubits, 2);
  assert.equal(r.control?.circuit?.gates.length, 2);
  assert.equal(r.control?.circuit?.gates[1]?.gate, 'cnot');
  assert.equal(r.control?.circuit?.gates[1]?.target, 1);
  assert.ok(!r.spoken.includes('{'), 'the payload must never reach the transcript');
});

t('accepts an uppercase gate name', () => {
  const r = parseAgentTurn('{"circuit":{"qubits":1,"gates":[{"gate":"H","qubit":0}]}}');
  assert.equal(r.control?.circuit?.gates[0]?.gate, 'h');
});

t('rejects a gate on a wire that does not exist', () => {
  const r = parseAgentTurn('{"circuit":{"qubits":2,"gates":[{"gate":"h","qubit":5}]}}');
  assert.equal(r.control?.circuit, undefined);
});

t('rejects a two-qubit gate with no target', () => {
  const r = parseAgentTurn('{"circuit":{"qubits":2,"gates":[{"gate":"cnot","qubit":0}]}}');
  assert.equal(r.control?.circuit, undefined);
});

t('rejects a two-qubit gate pointed at its own wire', () => {
  const r = parseAgentTurn(
    '{"circuit":{"qubits":2,"gates":[{"gate":"cnot","qubit":0,"target":0}]}}',
  );
  assert.equal(r.control?.circuit, undefined);
});

t('rejects a qubit index that arrived as a string', () => {
  // The single most likely malformation from an LLM, and the one that would
  // otherwise sail through a `typeof value === 'object'` check.
  const r = parseAgentTurn('{"circuit":{"qubits":2,"gates":[{"gate":"h","qubit":"0"}]}}');
  assert.equal(r.control?.circuit, undefined);
});

t('rejects an invented gate name', () => {
  const r = parseAgentTurn('{"circuit":{"qubits":2,"gates":[{"gate":"toffoli","qubit":0}]}}');
  assert.equal(r.control?.circuit, undefined);
});

t('rejects more qubits than the simulator supports', () => {
  const r = parseAgentTurn('{"circuit":{"qubits":9,"gates":[{"gate":"h","qubit":0}]}}');
  assert.equal(r.control?.circuit, undefined);
});

t('rejects a gate list that is not a list', () => {
  const r = parseAgentTurn('{"circuit":{"qubits":2,"gates":null}}');
  assert.equal(r.control?.circuit, undefined);
});

t('an empty gate list is treated as no payload, not as a clear', () => {
  const r = parseAgentTurn('{"circuit":{"qubits":2,"gates":[]}}');
  assert.equal(r.control?.circuit, undefined, 'must not wipe the board mid-explanation');
});

t('one bad gate drops the whole circuit', () => {
  // Partial reads are the dangerous case: a circuit missing its CNOT is not
  // the circuit Athena is describing out loud.
  const r = parseAgentTurn(
    '{"circuit":{"qubits":2,"gates":[{"gate":"h","qubit":0},{"gate":"cnot","qubit":0,"target":7}]}}',
  );
  assert.equal(r.control?.circuit, undefined);
});

t('a circuit rides alongside the other control fields', () => {
  const r = parseAgentTurn(
    'Good question, Ana. {"to":"Ana","circuit":{"qubits":1,"gates":[{"gate":"h","qubit":0}]}}',
  );
  assert.equal(r.control?.to, 'Ana');
  assert.equal(r.control?.circuit?.gates.length, 1);
});

t('keeps a rotation angle when one is given', () => {
  const r = parseAgentTurn(
    '{"circuit":{"qubits":1,"gates":[{"gate":"ry","qubit":0,"angle":1.5708}]}}',
  );
  assert.equal(r.control?.circuit?.gates[0]?.angle, 1.5708);
});

console.log(`\n${pass} passing`);
