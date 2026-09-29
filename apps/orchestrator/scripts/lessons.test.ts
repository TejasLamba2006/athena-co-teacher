/**
 * Tests for the guided lessons (quantum/lessons.ts).
 *
 * Two jobs. First, structural: a lesson whose narration array is one entry out
 * of step with its gate array will show the class the wrong sentence next to the
 * right circuit, and nothing else in the system would notice.
 *
 * Second, and the reason this file is longer than it looks: the narration makes
 * *claims*. "The probabilities look unchanged" and "all the amplitude has piled
 * onto 11" are assertions about numbers, so they are asserted here. If someone
 * edits a gate and forgets the prose, this fails — which is the only way the
 * prose and the physics stay honest with each other.
 *
 * Run with: node --import tsx scripts/lessons.test.ts
 */

import assert from 'node:assert/strict';
import { findLesson, LESSONS, lessonStates } from './../src/quantum/lessons.ts';
import { canSimulate, isBellState, MAX_QUBITS } from './../src/quantum/simulator.ts';

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

const near = (got: number, want: number, what: string, tol = 1e-9) =>
  assert.ok(Math.abs(got - want) <= tol, `${what}: got ${got}, expected ${want}`);

// ─── structure ───────────────────────────────────────────────────────────────

t('every lesson has one narration step per gate, plus the opening state', () => {
  for (const lesson of LESSONS) {
    assert.equal(
      lesson.steps.length,
      lesson.circuit.gates.length + 1,
      `${lesson.id}: ${lesson.steps.length} steps for ${lesson.circuit.gates.length} gates`,
    );
  }
});

t('lessonStates lines up index-for-index with the narration', () => {
  for (const lesson of LESSONS) {
    assert.equal(lessonStates(lesson).length, lesson.steps.length, lesson.id);
  }
});

t('every lesson is within the simulator limits', () => {
  for (const lesson of LESSONS) {
    assert.ok(lesson.circuit.qubits <= MAX_QUBITS, `${lesson.id} wants too many qubits`);
    assert.ok(canSimulate(lesson.circuit), `${lesson.id} has an unsimulatable circuit`);
  }
});

t('lesson ids are unique and findable', () => {
  const ids = LESSONS.map((l) => l.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate lesson id');
  for (const id of ids) assert.equal(findLesson(id)?.id, id);
  assert.equal(findLesson('no-such-lesson'), undefined);
});

t('no lesson ships an empty narration or an unlabelled gate', () => {
  for (const lesson of LESSONS) {
    assert.ok(lesson.title.length > 0 && lesson.summary.length > 0, `${lesson.id} metadata`);
    assert.ok(lesson.takeaway.length > 0, `${lesson.id} takeaway`);
    lesson.steps.forEach((step, i) => {
      assert.ok(step.narration.trim().length > 0, `${lesson.id} step ${i} has no narration`);
      // Step 0 is the state before any gate, so it alone may have no label.
      if (i > 0) assert.ok(step.gateLabel.trim().length > 0, `${lesson.id} step ${i} unlabelled`);
    });
  }
});

// ─── Bell: the narration claims ──────────────────────────────────────────────

t('bell: the intermediate state is a product, the final state is entangled', () => {
  const lesson = findLesson('bell');
  assert.ok(lesson);
  const [start, afterH, afterCnot] = lessonStates(lesson);
  assert.ok(start && afterH && afterCnot);

  // "One bar, full height."
  near(start.probabilities[0]!, 1, 'start P(00)');

  // "00 and 10 are equally likely ... the two qubits are still independent."
  near(afterH.probabilities[0]!, 0.5, 'after H, P(00)');
  near(afterH.probabilities[2]!, 0.5, 'after H, P(10)');
  assert.equal(afterH.entangled, false, 'the narration says they are still independent');

  // "00 and 11, nothing else. ... That is entanglement."
  near(afterCnot.probabilities[0]!, 0.5, 'final P(00)');
  near(afterCnot.probabilities[3]!, 0.5, 'final P(11)');
  near(afterCnot.probabilities[1]!, 0, 'final P(01)');
  near(afterCnot.probabilities[2]!, 0, 'final P(10)');
  assert.equal(afterCnot.entangled, true);
  assert.equal(isBellState(afterCnot), true);
});

// ─── Deutsch-Jozsa: the narration claims ─────────────────────────────────────

t('deutsch-jozsa: the oracle changes no probability, only a phase', () => {
  const lesson = findLesson('deutsch-jozsa');
  assert.ok(lesson);
  const states = lessonStates(lesson);
  const beforeOracle = states[3];
  const afterOracle = states[4];
  assert.ok(beforeOracle && afterOracle);

  // "The probabilities look unchanged, and that is the point."
  beforeOracle.probabilities.forEach((p, k) =>
    near(afterOracle.probabilities[k]!, p, `oracle moved P(${k})`),
  );
  // ...but the state itself did change, or there would be nothing to recover.
  const moved = afterOracle.amplitudes.some(
    (a, k) => Math.abs(a.re - beforeOracle.amplitudes[k]!.re) > 1e-9,
  );
  assert.ok(moved, 'the oracle must leave a phase behind');
});

t('deutsch-jozsa: the balanced oracle leaves the input qubit certainly 1', () => {
  const lesson = findLesson('deutsch-jozsa');
  assert.ok(lesson);
  const final = lessonStates(lesson).at(-1);
  assert.ok(final);

  // "The input qubit is now definitely 1. A 1 means balanced."
  // Qubit 0 is the most significant bit, so "input = 1" is indices 2 and 3.
  const inputIsOne = final.probabilities[2]! + final.probabilities[3]!;
  near(inputIsOne, 1, 'P(input qubit = 1)');
  near(final.probabilities[0]! + final.probabilities[1]!, 0, 'P(input qubit = 0)');
});

// ─── Grover: the narration claims ────────────────────────────────────────────

t('grover: after the Hadamards all four answers are equally likely', () => {
  const lesson = findLesson('grover');
  assert.ok(lesson);
  const uniform = lessonStates(lesson)[2];
  assert.ok(uniform);
  // "All four answers are now equally likely, 25% each."
  for (let k = 0; k < 4; k += 1) near(uniform.probabilities[k]!, 0.25, `P(${k})`);
});

t('grover: the oracle alone moves no bar', () => {
  const lesson = findLesson('grover');
  assert.ok(lesson);
  const states = lessonStates(lesson);
  const before = states[2];
  const after = states[3];
  assert.ok(before && after);

  // "The bars have not moved — all four are still at 25%."
  for (let k = 0; k < 4; k += 1) near(after.probabilities[k]!, 0.25, `after oracle, P(${k})`);
  // "...because a sign is invisible to a probability." The sign must be there.
  assert.ok(after.amplitudes[3]!.re < 0, 'the oracle must flip the sign of the marked state');
  assert.ok(before.amplitudes[3]!.re > 0, 'and it must have been positive before');
});

t('grover: one full round lands on the marked state with certainty', () => {
  const lesson = findLesson('grover');
  assert.ok(lesson);
  const final = lessonStates(lesson).at(-1);
  assert.ok(final);

  // "All the amplitude has piled onto 11 ... the answer comes out with certainty."
  near(final.probabilities[3]!, 1, 'P(11)');
  for (const k of [0, 1, 2]) near(final.probabilities[k]!, 0, `P(${k})`);
});

t('grover: the marked state is the one the oracle picked, not a hardcoded 11', () => {
  // Guards against a diffusion block that happens to concentrate on the last
  // index regardless of the oracle. Drop the oracle and the answer must change.
  const lesson = findLesson('grover');
  assert.ok(lesson);
  const withoutOracle = {
    ...lesson.circuit,
    // The oracle is the first CZ; the second belongs to the diffusion block.
    gates: lesson.circuit.gates.filter((g, i) => !(g.gate === 'cz' && i === 2)),
  };
  const states = lessonStates({ ...lesson, circuit: withoutOracle });
  const final = states.at(-1);
  assert.ok(final);
  assert.ok(
    Math.abs(final.probabilities[3]! - 1) > 1e-6,
    'without the oracle the search must not still find 11',
  );
});

console.log(`\n${pass} passing`);
