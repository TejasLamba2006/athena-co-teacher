/**
 * Unit tests for the state-vector simulator (quantum/simulator.ts).
 *
 * Every assertion here is against a value worked out by hand or published in a
 * reference, not against the simulator's own previous output — a simulator that
 * "agrees with itself" proves nothing, and the whole grading path (does this
 * student's circuit make a Bell state?) rests on these numbers being right.
 *
 * Run with: node --import tsx scripts/quantum.test.ts
 */

import assert from 'node:assert/strict';
import {
  basisLabel,
  canSimulate,
  collapse,
  initialState,
  isBellState,
  isEntangled,
  matches,
  MAX_QUBITS,
  probabilityOf,
  sampleOutcome,
  simulate,
  simulateSteps,
  type Circuit,
  type GateName,
} from './../src/quantum/simulator.ts';

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

/** Assert probability k is close to `expected`, with a readable failure. */
const prob = (result: { probabilities: number[] }, k: number, expected: number, tol = 1e-9) => {
  const got = result.probabilities[k];
  assert.ok(
    Math.abs(got - expected) <= tol,
    `P(${basisLabel(k, Math.log2(result.probabilities.length))}) = ${got}, expected ${expected}`,
  );
};

/** Every amplitude should have zero imaginary part unless a phase gate was used. */
const allReal = (result: { amplitudes: { im: number }[] }) =>
  result.amplitudes.every((a) => Math.abs(a.im) < 1e-9);

const S2 = Math.SQRT1_2;

// ─── initial state ───────────────────────────────────────────────────────────

t('initialState is |0...0> with unit amplitude on index 0', () => {
  const state = initialState(3);
  assert.equal(state.length, 8);
  assert.deepEqual(state[0], { re: 1, im: 0 });
  for (let k = 1; k < 8; k += 1) assert.equal(Math.hypot(state[k].re, state[k].im), 0);
});

// ─── single-qubit gates ──────────────────────────────────────────────────────

t('H|0> = (|0>+|1>)/sqrt2 — the equal superposition', () => {
  const r = simulate({ qubits: 1, gates: [{ gate: 'h', qubit: 0 }] });
  prob(r, 0, 0.5);
  prob(r, 1, 0.5);
});

t('H is its own inverse: HH|0> = |0>', () => {
  const r = simulate({
    qubits: 1,
    gates: [
      { gate: 'h', qubit: 0 },
      { gate: 'h', qubit: 0 },
    ],
  });
  prob(r, 0, 1);
  prob(r, 1, 0);
});

t('X|0> = |1>', () => {
  const r = simulate({ qubits: 1, gates: [{ gate: 'x', qubit: 0 }] });
  prob(r, 0, 0);
  prob(r, 1, 1);
});

t('X|1> = |0>', () => {
  const r = simulate({
    qubits: 1,
    gates: [
      { gate: 'x', qubit: 0 },
      { gate: 'x', qubit: 0 },
    ],
  });
  prob(r, 0, 1);
});

t('Z|0> = |0> (Z flips phase, not probability)', () => {
  const r = simulate({ qubits: 1, gates: [{ gate: 'z', qubit: 0 }] });
  prob(r, 0, 1);
  prob(r, 1, 0);
});

t('S and T produce the right global phase on |1>', () => {
  const x = { gate: 'x', qubit: 0 } as const;

  const s = simulate({ qubits: 1, gates: [x, { gate: 's', qubit: 0 }] });
  assert.ok(Math.abs(s.amplitudes[1].im - 1) < 1e-9, 'S|1> = i|1>');

  const sdg = simulate({ qubits: 1, gates: [x, { gate: 'sdg', qubit: 0 }] });
  assert.ok(Math.abs(sdg.amplitudes[1].im + 1) < 1e-9, 'Sdg|1> = -i|1>');

  const t = simulate({ qubits: 1, gates: [x, { gate: 't', qubit: 0 }] });
  assert.ok(
    Math.abs(t.amplitudes[1].re - S2) < 1e-9 && Math.abs(t.amplitudes[1].im - S2) < 1e-9,
    'T|1> = e^(i*pi/4)|1>',
  );
});

t('Tdg is T inverted: T then Tdg is the identity', () => {
  const r = simulate({
    qubits: 1,
    gates: [
      { gate: 'x', qubit: 0 },
      { gate: 't', qubit: 0 },
      { gate: 'tdg', qubit: 0 },
    ],
  });
  assert.ok(
    Math.abs(r.amplitudes[1].re - 1) < 1e-9 && Math.abs(r.amplitudes[1].im) < 1e-9,
    `expected amplitude back to +1, got ${JSON.stringify(r.amplitudes[1])}`,
  );
});

t('every gate canSimulate accepts is a gate simulate can actually run', () => {
  // The bug this locks down: `tdg` was accepted by canSimulate (and by the
  // route and control-payload validators built on the same name list) while
  // `matrix1` had no case for it — so it passed every check and then threw
  // from inside simulate(). gradeSubmission calls simulate directly, so a
  // student submitting that gate crashed their own request.
  const names: GateName[] = [
    'h', 'x', 'y', 'z', 's', 'sdg', 't', 'tdg', 'rx', 'ry', 'rz', 'cnot', 'cz', 'swap',
  ];
  for (const gate of names) {
    const circuit: Circuit =
      gate === 'cnot' || gate === 'cz' || gate === 'swap'
        ? { qubits: 2, gates: [{ gate, qubit: 0, target: 1 }] }
        : { qubits: 2, gates: [{ gate, qubit: 0, angle: 0.5 }] };
    assert.equal(canSimulate(circuit), true, `canSimulate rejected ${gate}`);
    assert.doesNotThrow(() => simulate(circuit), `simulate threw on ${gate}`);
  }
});

t('S applied twice is Z (S is a quarter turn)', () => {
  const r = simulate({
    qubits: 1,
    gates: [
      { gate: 'x', qubit: 0 },
      { gate: 's', qubit: 0 },
      { gate: 's', qubit: 0 },
    ],
  });
  // |1> -> i|1> -> -|1>: same probabilities as Z, opposite sign.
  assert.ok(Math.abs(r.amplitudes[1].re + 1) < 1e-9, 'expected amplitude -1 on |1>');
});

t('RY(pi) turns |0> fully into |1>', () => {
  const r = simulate({ qubits: 1, gates: [{ gate: 'ry', angle: Math.PI, qubit: 0 }] });
  prob(r, 0, 0);
  prob(r, 1, 1);
});

t('RX(pi) turns |0> fully into |1> up to phase', () => {
  const r = simulate({ qubits: 1, gates: [{ gate: 'rx', angle: Math.PI, qubit: 0 }] });
  prob(r, 0, 0);
  prob(r, 1, 1);
});

t('RX carries an i-phase: RX(pi)|0> = -i|1>', () => {
  const r = simulate({ qubits: 1, gates: [{ gate: 'rx', angle: Math.PI, qubit: 0 }] });
  assert.ok(
    Math.abs(r.amplitudes[1].re) < 1e-9 && Math.abs(r.amplitudes[1].im + 1) < 1e-9,
    `expected -i on |1>, got ${JSON.stringify(r.amplitudes[1])}`,
  );
});

t('RZ is a pure phase: probabilities never change', () => {
  // This is the gate that breaks if you treat it as a real rotation. On |1>
  // (amplitude 1 at index 1), RZ(t) gives e^(+i*t/2), so the imaginary part of
  // the |1> amplitude is sin(t/2). For t = 1.234 that is sin(0.617) ~ 0.5786.
  const before = simulate({ qubits: 1, gates: [{ gate: 'x', qubit: 0 }] });
  const after = simulate({
    qubits: 1,
    gates: [
      { gate: 'x', qubit: 0 },
      { gate: 'rz', angle: 1.234, qubit: 0 },
    ],
  });
  assert.deepEqual(after.probabilities, before.probabilities);
  // The phase must actually have moved, and moved to exactly the right value.
  assert.ok(
    Math.abs(after.amplitudes[1].im - Math.sin(1.234 / 2)) < 1e-9,
    `expected im = ${Math.sin(1.234 / 2)}, got ${after.amplitudes[1].im}`,
  );
  assert.ok(
    Math.abs(after.amplitudes[1].re - Math.cos(1.234 / 2)) < 1e-9,
    `expected re = ${Math.cos(1.234 / 2)}, got ${after.amplitudes[1].re}`,
  );
});

t('RZ by 2pi is the identity', () => {
  const plain = simulate({ qubits: 1, gates: [{ gate: 'x', qubit: 0 }] });
  const turned = simulate({
    qubits: 1,
    gates: [
      { gate: 'x', qubit: 0 },
      { gate: 'rz', angle: 2 * Math.PI, qubit: 0 },
    ],
  });
  assert.ok(
    Math.abs(turned.amplitudes[1].im) < 1e-9 && Math.abs(turned.amplitudes[1].re - 1) < 1e-9,
    `expected amplitude back to +1, got ${JSON.stringify(turned.amplitudes[1])}`,
  );
  void plain;
});

t('a rotation angle past 2pi wraps rather than exploding', () => {
  const a = simulate({ qubits: 1, gates: [{ gate: 'ry', angle: 0.7, qubit: 0 }] });
  const b = simulate({ qubits: 1, gates: [{ gate: 'ry', angle: 0.7 + 4 * Math.PI, qubit: 0 }] });
  assert.ok(matches(a, b));
});

// ─── Bell state: the lesson this whole module exists for ─────────────────────

const BELL: Circuit = {
  qubits: 2,
  gates: [
    { gate: 'h', qubit: 0 },
    { gate: 'cnot', qubit: 0, target: 1 },
  ],
};

/** Same two gates as BELL, but in the order that entangles nothing. */
const CNOT_THEN_H: Circuit = {
  qubits: 2,
  gates: [
    { gate: 'cnot', qubit: 0, target: 1 },
    { gate: 'h', qubit: 0 },
  ],
};

t('Bell state: H then CNOT gives exactly 50/50 on |00> and |11>', () => {
  const r = simulate(BELL);
  prob(r, 0, 0.5); // |00>
  prob(r, 1, 0); // |01>
  prob(r, 2, 0); // |10>
  prob(r, 3, 0.5); // |11>
  assert.equal(Math.abs(r.amplitudes[0].re - S2) < 1e-9, true);
  assert.equal(r.amplitudes[3].im, 0, 'Bell state is real — no relative phase');
});

t('Bell state is entangled', () => {
  assert.equal(simulate(BELL).entangled, true);
});

t('Bell state is recognised by isBellState', () => {
  assert.equal(isBellState(simulate(BELL)), true);
});

t('CNOT then H does NOT entangle — the whole point of gate order', () => {
  const r = simulate(CNOT_THEN_H);
  // (H|0>) (x) |0> = (|00> + |10>)/sqrt2 — a product state.
  prob(r, 0, 0.5);
  prob(r, 2, 0.5);
  assert.equal(r.entangled, false);
  assert.equal(isBellState(r), false);
});

t('CNOT with control in a definite |0> is a no-op', () => {
  const r = simulate({ qubits: 2, gates: [{ gate: 'cnot', qubit: 0, target: 1 }] });
  prob(r, 0, 1, 1e-12);
  assert.equal(r.entangled, false);
});

t('the two orderings genuinely differ (guards against a symmetric gate impl)', () => {
  assert.equal(matches(simulate(BELL), simulate(CNOT_THEN_H)), false);
});

// ─── entanglement detector ───────────────────────────────────────────────────

t('a single qubit is never entangled', () => {
  assert.equal(simulate({ qubits: 1, gates: [{ gate: 'h', qubit: 0 }] }).entangled, false);
});

t('a product state across two qubits is not entangled', () => {
  // H on qubit 0 only: qubit 1 stays in |0>, so the state factors.
  const r = simulate({ qubits: 2, gates: [{ gate: 'h', qubit: 0 }] });
  prob(r, 0, 0.5);
  prob(r, 2, 0.5);
  assert.equal(r.entangled, false);
});

t('the canonical GHZ state |000>+|111> is entangled', () => {
  const r = simulate({
    qubits: 3,
    gates: [
      { gate: 'h', qubit: 0 },
      { gate: 'cnot', qubit: 0, target: 1 },
      { gate: 'cnot', qubit: 1, target: 2 },
    ],
  });
  prob(r, 0, 0.5); // |000>
  prob(r, 7, 0.5); // |111>
  assert.equal(r.entangled, true);
});

t('a uniform superposition over 3 qubits is NOT entangled', () => {
  // H on all three = |+>|+>|+>: eight equal terms, but still a plain product of
  // three independent qubits. "Spread across every basis state" and "entangled"
  // are different things, and a detector that confuses them would flag the most
  // common teaching circuit in the module as entangled.
  const r = simulate({
    qubits: 3,
    gates: [
      { gate: 'h', qubit: 0 },
      { gate: 'h', qubit: 1 },
      { gate: 'h', qubit: 2 },
    ],
  });
  for (let k = 0; k < 8; k += 1) prob(r, k, 0.125);
  assert.equal(r.entangled, false);
});

t('a 2-qubit state that is a product but not all-zero is not entangled', () => {
  // X then H on qubit 0 gives (|0>-|1>)/sqrt2 (x) |0>: real, and a product.
  const r = simulate({
    qubits: 2,
    gates: [
      { gate: 'x', qubit: 0 },
      { gate: 'h', qubit: 0 },
    ],
  });
  prob(r, 0, 0.5);
  prob(r, 2, 0.5);
  assert.equal(r.entangled, false);
});

t('Bell state with a relative phase is still entangled', () => {
  // H, CNOT, then T on qubit 0 -> (|00> + i|11>)/sqrt2. Entanglement does not
  // care about phase; probabilities alone would look identical to the plain
  // Bell state.
  const r = simulate({
    qubits: 2,
    gates: [
      { gate: 'h', qubit: 0 },
      { gate: 'cnot', qubit: 0, target: 1 },
      { gate: 't', qubit: 0 },
    ],
  });
  prob(r, 0, 0.5);
  prob(r, 3, 0.5);
  assert.equal(r.entangled, true);
  assert.equal(
    isBellState(r),
    false,
    'a phase-shifted Bell pair is not the canonical Phi+ — grading must say so',
  );
});

// ─── two-qubit gates ─────────────────────────────────────────────────────────

t('CNOT flips the target only when the control is 1', () => {
  // Put qubit 0 in |1>, then CNOT.
  const r = simulate({
    qubits: 2,
    gates: [
      { gate: 'x', qubit: 0 },
      { gate: 'cnot', qubit: 0, target: 1 },
    ],
  });
  prob(r, 0, 0); // |00>
  prob(r, 1, 0); // |01>
  prob(r, 2, 0); // |10>
  prob(r, 3, 1); // |11>
});

t('CZ applies a -1 phase to |11> and nothing else', () => {
  const r = simulate({ qubits: 2, gates: [{ gate: 'cz', qubit: 0, target: 1 }] });
  prob(r, 0, 1);
  assert.equal(r.amplitudes[0].re, 1, '|11> is unreachable from |00> so nothing flips');
});

t('CZ on a Bell state flips the sign of the |11> term', () => {
  const r = simulate({
    qubits: 2,
    gates: [
      { gate: 'h', qubit: 0 },
      { gate: 'cnot', qubit: 0, target: 1 },
      { gate: 'cz', qubit: 0, target: 1 },
    ],
  });
  assert.ok(Math.abs(r.amplitudes[0].re - S2) < 1e-9, '|00> term keeps its sign');
  assert.ok(Math.abs(r.amplitudes[3].re + S2) < 1e-9, '|11> term picks up -1');
});

t('SWAP exchanges the two qubits', () => {
  // |10> (qubit 0 set) becomes |01>.
  const r = simulate({
    qubits: 2,
    gates: [
      { gate: 'x', qubit: 0 },
      { gate: 'swap', qubit: 0, target: 1 },
    ],
  });
  prob(r, 1, 1); // |01>
  prob(r, 2, 0);
});

t('SWAP applied twice is the identity', () => {
  const r = simulate({
    qubits: 2,
    gates: [
      { gate: 'h', qubit: 0 },
      { gate: 'swap', qubit: 0, target: 1 },
      { gate: 'swap', qubit: 0, target: 1 },
    ],
  });
  prob(r, 0, 0.5);
  prob(r, 2, 0.5);
});

t('a two-qubit gate refuses a target equal to its own qubit', () => {
  assert.throws(
    () => simulate({ qubits: 2, gates: [{ gate: 'cnot', qubit: 0, target: 0 }] }),
    /distinct target/,
  );
});

t('a two-qubit gate refuses a missing target', () => {
  assert.throws(
    () => simulate({ qubits: 2, gates: [{ gate: 'cnot', qubit: 0 }] }),
    /distinct target/,
  );
});

// ─── invariants ──────────────────────────────────────────────────────────────

t('probabilities always sum to 1', () => {
  const circuits: Circuit[] = [
    { qubits: 1, gates: [{ gate: 'h', qubit: 0 }] },
    BELL,
    CNOT_THEN_H,
    {
      qubits: 3,
      gates: [
        { gate: 'h', qubit: 0 },
        { gate: 'h', qubit: 1 },
        { gate: 'h', qubit: 2 },
        { gate: 'cnot', qubit: 0, target: 1 },
        { gate: 't', qubit: 2 },
        { gate: 'swap', qubit: 0, target: 2 },
      ],
    },
  ];
  for (const c of circuits) {
    const total = simulate(c).probabilities.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `sum was ${total} for ${c.gates.length} gates`);
  }
});

t('probabilityOf matches the amplitudes', () => {
  const r = simulate(BELL);
  assert.deepEqual(probabilityOf(r.amplitudes), r.probabilities);
});

t('gates on disjoint qubits commute', () => {
  const ab = simulate({
    qubits: 2,
    gates: [
      { gate: 'h', qubit: 0 },
      { gate: 'x', qubit: 1 },
    ],
  });
  const ba = simulate({
    qubits: 2,
    gates: [
      { gate: 'x', qubit: 1 },
      { gate: 'h', qubit: 0 },
    ],
  });
  assert.ok(matches(ab, ba));
  assert.equal(isEntangled(ab.amplitudes, 2), false);
});

// ─── guards ──────────────────────────────────────────────────────────────────

t('canSimulate rejects more qubits than MAX_QUBITS', () => {
  assert.equal(canSimulate({ qubits: MAX_QUBITS, gates: [] }), true);
  assert.equal(canSimulate({ qubits: MAX_QUBITS + 1, gates: [] }), false);
});

t('canSimulate rejects an out-of-range qubit index', () => {
  assert.equal(canSimulate({ qubits: 2, gates: [{ gate: 'h', qubit: 5 }] }), false);
  assert.equal(canSimulate({ qubits: 2, gates: [{ gate: 'h', qubit: -1 }] }), false);
});

t('simulate throws rather than returning a wrong state for an unsupported circuit', () => {
  assert.throws(() => simulate({ qubits: 9, gates: [] }), /Cannot simulate/);
});

t('an empty circuit is the trivial |0...0> state', () => {
  const r = simulate({ qubits: 3, gates: [] });
  prob(r, 0, 1);
  assert.equal(r.entangled, false);
});

// ─── step-through ────────────────────────────────────────────────────────────

t('simulateSteps returns one state per gate, plus the empty prefix', () => {
  const steps = simulateSteps(BELL);
  assert.equal(steps.length, BELL.gates.length + 1);
  prob(steps[0], 0, 1); // before any gate
  prob(steps[1], 0, 0.5); // after H
  prob(steps[1], 2, 0.5); // (|00>+|10>)/sqrt2 — not entangled yet
  prob(steps[2], 0, 0.5); // after CNOT -> Bell
  prob(steps[2], 3, 0.5);
  assert.equal(steps[1].entangled, false);
  assert.equal(steps[2].entangled, true);
});

// ─── measurement ─────────────────────────────────────────────────────────────

t('sampleOutcome is deterministic given a pinned random draw', () => {
  const r = simulate(BELL);
  assert.equal(sampleOutcome(r, () => 0.1), 0);
  assert.equal(sampleOutcome(r, () => 0.9), 3);
  assert.equal(sampleOutcome(r, () => 0.0), 0);
  assert.equal(sampleOutcome(r, () => 0.999), 3);
});

t('a draw at exactly the boundary lands in the next bucket', () => {
  const r = simulate(BELL);
  assert.equal(sampleOutcome(r, () => 0.5), 3, 'the upper half belongs to |11>');
});

t('sampleOutcome never returns an out-of-range index', () => {
  const r = simulate(BELL);
  for (let i = 0; i <= 100; i += 1) {
    const k = sampleOutcome(r, () => i / 100);
    assert.ok(k >= 0 && k < r.probabilities.length, `bad index ${k}`);
  }
});

t('sampling a Bell state always returns 00 or 11, never 01 or 10', () => {
  const r = simulate(BELL);
  for (let i = 0; i <= 100; i += 1) {
    const k = sampleOutcome(r, () => i / 100);
    assert.ok(k === 0 || k === 3, `sampled ${basisLabel(k, 2)}, which has zero probability`);
  }
});

t('collapse zeroes every branch but the measured one and renormalises', () => {
  const r = simulate(BELL);
  const collapsed = collapse(r.amplitudes, 3);
  assert.equal(collapsed.length, 4);
  for (let k = 0; k < 4; k += 1) {
    const expected = k === 3 ? 1 : 0;
    assert.ok(Math.abs(collapsed[k].re - expected) < 1e-9, `index ${k}`);
  }
});

// ─── grading primitive ───────────────────────────────────────────────────────

t('matches ignores global phase: -|psi> grades the same as |psi>', () => {
  const r = simulate(BELL);
  const negated = {
    ...r,
    amplitudes: r.amplitudes.map((a) => ({ re: -a.re, im: -a.im })),
    probabilities: r.probabilities,
  };
  assert.equal(matches(r, negated), true);
});

t('matches rejects different qubit counts', () => {
  assert.equal(matches(simulate(BELL), simulate({ qubits: 1, gates: [{ gate: 'h', qubit: 0 }] })), false);
});

t('isBellState accepts the 01/10 variant (Psi+), not just Phi+', () => {
  // H, CNOT, then X on qubit 1 flips the second wire of every term, turning
  // (|00>+|11>)/sqrt2 into (|01>+|10>)/sqrt2. Different indices, same physics —
  // grading must not be hardcoded to the |00>/|11> pair.
  const r = simulate({
    qubits: 2,
    gates: [
      { gate: 'h', qubit: 0 },
      { gate: 'cnot', qubit: 0, target: 1 },
      { gate: 'x', qubit: 1 },
    ],
  });
  prob(r, 0, 0); // |00>
  prob(r, 1, 0.5); // |01>
  prob(r, 2, 0.5); // |10>
  prob(r, 3, 0); // |11>
  assert.equal(r.entangled, true);
  assert.equal(isBellState(r), true);
});

t('isBellState rejects a biased two-outcome state', () => {
  // 0.75/0.25 across complementary states is entangled but not a Bell pair.
  const r = simulate({
    qubits: 2,
    gates: [
      { gate: 'ry', angle: Math.PI / 3, qubit: 0 },
      { gate: 'cnot', qubit: 0, target: 1 },
    ],
  });
  assert.ok(Math.abs(r.probabilities[0] - 0.75) < 1e-9);
  assert.ok(Math.abs(r.probabilities[3] - 0.25) < 1e-9);
  assert.equal(r.entangled, true);
  assert.equal(isBellState(r), false);
});

console.log(`\n${pass} passing`);
