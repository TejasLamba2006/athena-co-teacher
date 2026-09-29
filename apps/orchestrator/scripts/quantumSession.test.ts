/**
 * Tests for the playground's session layer (quantum/quantumSession.ts).
 *
 * The simulator is already covered by quantum.test.ts; this file covers the
 * two things built on top of it that a student actually experiences:
 *
 *  - grading. A wrong verdict on "build a Bell state" teaches the wrong physics,
 *    and the failure is silent — the student just believes the machine.
 *  - `describeForAgent`. This is the entire screen -> Athena channel. If it
 *    says "not entangled" about an entangled state, Athena says it out loud to
 *    the room, with total confidence, in a voice the class trusts.
 *
 * Run with: node --import tsx scripts/quantumSession.test.ts
 */

import assert from 'node:assert/strict';
import { createSession } from './../src/state/sessionRegistry.ts';
import {
  applyCircuit,
  describeForAgent,
  gradeSubmission,
  setChallenge,
  startLesson,
  stepLesson,
} from './../src/quantum/quantumSession.ts';
import type { QuantumCircuit } from '@echosphere/shared-types';

let pass = 0;
const t = (name: string, fn: () => void) => {
  try {
    fn();
    pass += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.log(`  FAIL ${name}: ${(e as Error).message}`);
    process.exitCode = 1;
  }
};

const fresh = () => createSession('quantum test');

const BELL: QuantumCircuit = {
  qubits: 2,
  gates: [
    { gate: 'h', qubit: 0 },
    { gate: 'cnot', qubit: 0, target: 1 },
  ],
};
/** The classic mistake: right gates, wrong order. */
const REVERSED: QuantumCircuit = {
  qubits: 2,
  gates: [
    { gate: 'cnot', qubit: 0, target: 1 },
    { gate: 'h', qubit: 0 },
  ],
};

const bellChallenge = {
  id: 'ch1',
  prompt: 'Build a Bell state on two qubits.',
  qubits: 2,
  check: 'bell' as const,
};

// ─── putting a circuit on screen ─────────────────────────────────────────────

t('applyCircuit opens the playground and stores the result', () => {
  const s = fresh();
  assert.equal(s.quantum.open, false);
  const out = applyCircuit(s, BELL);
  assert.ok(out.ok);
  assert.equal(s.quantum.open, true);
  assert.equal(s.quantum.result?.entangled, true);
  // Labels are baked server-side so the browser never guesses the bit order.
  assert.deepEqual(
    s.quantum.result?.outcomes.map((o) => o.label),
    ['|00⟩', '|01⟩', '|10⟩', '|11⟩'],
  );
});

t('applyCircuit rejects a circuit that references a missing wire', () => {
  const s = fresh();
  const out = applyCircuit(s, { qubits: 2, gates: [{ gate: 'h', qubit: 5 }] });
  assert.equal(out.ok, false);
  // A rejected circuit must not half-apply: the screen still shows nothing.
  assert.equal(s.quantum.open, false);
  assert.equal(s.quantum.result, null);
});

t('applyCircuit rejects more qubits than the simulator supports', () => {
  const s = fresh();
  assert.equal(applyCircuit(s, { qubits: 9, gates: [] }).ok, false);
  assert.equal(applyCircuit(s, { qubits: 0, gates: [] }).ok, false);
});

t('free play clears any leftover lesson narration', () => {
  const s = fresh();
  startLesson(s, 'bell');
  assert.ok(s.quantum.narration);
  applyCircuit(s, REVERSED);
  assert.equal(s.quantum.narration, null, 'a stale sentence must not sit under a new circuit');
  assert.equal(s.quantum.lessonId, null);
});

// ─── lessons ─────────────────────────────────────────────────────────────────

t('startLesson opens at step 0 with the pre-gate state', () => {
  const s = fresh();
  assert.ok(startLesson(s, 'bell').ok);
  assert.equal(s.quantum.stepIndex, 0);
  assert.equal(s.quantum.circuit.gates.length, 0, 'step 0 has run no gates');
  assert.equal(s.quantum.result?.outcomes[0]?.probability, 1);
});

t('startLesson rejects an unknown lesson', () => {
  const s = fresh();
  assert.equal(startLesson(s, 'quantum-teleportation-in-one-gate').ok, false);
});

t('stepping forward grows the circuit one gate at a time', () => {
  const s = fresh();
  startLesson(s, 'bell');
  stepLesson(s, 1);
  assert.equal(s.quantum.circuit.gates.length, 1, 'shows only the gates that have run');
  assert.equal(s.quantum.result?.entangled, false, 'after H alone, still a product');
  stepLesson(s, 1);
  assert.equal(s.quantum.circuit.gates.length, 2);
  assert.equal(s.quantum.result?.entangled, true);
});

t('stepping clamps at both ends rather than wrapping', () => {
  const s = fresh();
  startLesson(s, 'bell');
  for (let i = 0; i < 10; i += 1) stepLesson(s, 1);
  assert.equal(s.quantum.stepIndex, 2, 'bell has 3 steps; the last index is 2');
  for (let i = 0; i < 10; i += 1) stepLesson(s, -1);
  assert.equal(s.quantum.stepIndex, 0, 'clicking back past the start must not wrap to the end');
});

t('stepping with no lesson open is refused, not silently ignored', () => {
  const s = fresh();
  assert.equal(stepLesson(s, 1).ok, false);
});

// ─── grading ─────────────────────────────────────────────────────────────────

t('a correct Bell circuit is graded correct', () => {
  const s = fresh();
  setChallenge(s, bellChallenge);
  const v = gradeSubmission(s, 'stu1', BELL);
  assert.ok(!('ok' in v));
  assert.equal(v.correct, true);
  assert.equal(v.participantId, 'stu1');
});

t('an unusual but valid Bell circuit is also correct', () => {
  // Psi+ via H, CNOT, X. Grading by state means there is no single "the"
  // answer, which is the entire reason the simulator exists.
  const s = fresh();
  setChallenge(s, bellChallenge);
  const v = gradeSubmission(s, 'stu1', {
    qubits: 2,
    gates: [
      { gate: 'h', qubit: 0 },
      { gate: 'cnot', qubit: 0, target: 1 },
      { gate: 'x', qubit: 1 },
    ],
  });
  assert.ok(!('ok' in v));
  assert.equal(v.correct, true, 'Psi+ is a Bell state too');
});

t('the reversed-order circuit is wrong, and the feedback names the mistake', () => {
  const s = fresh();
  setChallenge(s, bellChallenge);
  const v = gradeSubmission(s, 'stu1', REVERSED);
  assert.ok(!('ok' in v));
  assert.equal(v.correct, false);
  assert.match(v.feedback, /CNOT runs before the Hadamard/i);
});

t('an empty submission says so instead of guessing at a mistake', () => {
  const s = fresh();
  setChallenge(s, bellChallenge);
  const v = gradeSubmission(s, 'stu1', { qubits: 2, gates: [] });
  assert.ok(!('ok' in v));
  assert.equal(v.correct, false);
  assert.match(v.feedback, /Nothing has been placed/i);
});

t('a superposition with no entanglement is diagnosed as unentangled', () => {
  const s = fresh();
  setChallenge(s, bellChallenge);
  const v = gradeSubmission(s, 'stu1', { qubits: 2, gates: [{ gate: 'h', qubit: 0 }] });
  assert.ok(!('ok' in v));
  assert.equal(v.correct, false);
  assert.match(v.feedback, /still independent/i);
});

t('an entangled-but-biased pair is not accepted as a Bell state', () => {
  const s = fresh();
  setChallenge(s, bellChallenge);
  const v = gradeSubmission(s, 'stu1', {
    qubits: 2,
    gates: [
      { gate: 'ry', angle: Math.PI / 3, qubit: 0 },
      { gate: 'cnot', qubit: 0, target: 1 },
    ],
  });
  assert.ok(!('ok' in v));
  assert.equal(v.correct, false, '75/25 is entangled but is not a Bell pair');
});

t('a state-target challenge grades against the target distribution', () => {
  const s = fresh();
  setChallenge(s, {
    id: 'ch2',
    prompt: 'Put one qubit in an even superposition.',
    qubits: 1,
    check: 'state',
    expected: [0.5, 0.5],
  });
  const right = gradeSubmission(s, 'stu1', { qubits: 1, gates: [{ gate: 'h', qubit: 0 }] });
  assert.ok(!('ok' in right));
  assert.equal(right.correct, true);

  const wrong = gradeSubmission(s, 'stu1', { qubits: 1, gates: [{ gate: 'x', qubit: 0 }] });
  assert.ok(!('ok' in wrong));
  assert.equal(wrong.correct, false);
});

t('grading with no challenge open is refused', () => {
  const s = fresh();
  const v = gradeSubmission(s, 'stu1', BELL);
  assert.ok('ok' in v && v.ok === false);
});

t('setting a challenge clears the previous answer off the board', () => {
  const s = fresh();
  applyCircuit(s, BELL);
  setChallenge(s, bellChallenge);
  assert.equal(s.quantum.circuit.gates.length, 0, 'the next student must start empty');
  assert.equal(s.quantum.result, null);
});

// ─── the screen -> Athena channel ────────────────────────────────────────────

t('describeForAgent says nothing is showing when the board is closed', () => {
  assert.match(describeForAgent(fresh()), /not currently on screen/i);
});

t('describeForAgent reports the gates, the outcomes, and entanglement', () => {
  const s = fresh();
  applyCircuit(s, BELL);
  const text = describeForAgent(s);
  assert.match(text, /H on q0/);
  assert.match(text, /CNOT q0->q1/);
  assert.match(text, /\|00⟩ at 50%/);
  assert.match(text, /\|11⟩ at 50%/);
  assert.match(text, /are entangled/);
  assert.doesNotMatch(text, /not entangled/, 'must not describe a Bell pair as a product state');
});

t('describeForAgent distinguishes the unentangled case', () => {
  const s = fresh();
  applyCircuit(s, REVERSED);
  const text = describeForAgent(s);
  assert.match(text, /not entangled/);
});

t('describeForAgent omits zero-probability outcomes', () => {
  const s = fresh();
  applyCircuit(s, BELL);
  const text = describeForAgent(s);
  assert.doesNotMatch(text, /\|01⟩/, 'an impossible outcome is noise in a spoken sentence');
});

t('describeForAgent names the lesson position during a walkthrough', () => {
  const s = fresh();
  startLesson(s, 'grover');
  stepLesson(s, 1);
  assert.match(describeForAgent(s), /step 2 of 13/);
});

t('describeForAgent surfaces the open challenge', () => {
  const s = fresh();
  applyCircuit(s, BELL);
  setChallenge(s, bellChallenge);
  applyCircuit(s, REVERSED); // a student is mid-attempt
  assert.match(describeForAgent(s), /Build a Bell state/);
});

console.log(`\n${pass} passing`);
