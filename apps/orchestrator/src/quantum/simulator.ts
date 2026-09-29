/**
 * A state-vector simulator for 1-4 qubits.
 *
 * Why hand-rolled rather than a library: at this size the state is a vector of
 * 2^n complex numbers — at most 16. Every gate is a 2x2 matrix applied to
 * bit-pairs, and the probability bars are just |psi[k]|^2. That is a few dozen
 * lines of arithmetic, and owning it buys three things a dependency would not:
 * no supply-chain weight, the exact same file running in the orchestrator (to
 * grade a student's answer) and in the browser (to render the bars as they
 * edit), and no way for the two copies of the maths to drift apart — they are
 * one file.
 *
 * Ceiling, stated plainly: this is not a performance simulator and does not try
 * to be. It holds the full vector, so it is O(4^n) memory and time — fine to
 * n=4 (16 amplitudes), useless by n=20. If the curriculum ever needs many
 * qubits, swap this file for a library behind the same `simulate` signature;
 * nothing else in the codebase touches the internals.
 *
 * Pure: no I/O, no globals, no clock. Same input, same output — which is what
 * makes the grading path (orchestrator) and the display path (browser)
 * provably agree.
 */

/** A complex amplitude. `re`/`im` rather than a class — this is hot-ish math. */
export interface Amplitude {
  re: number;
  im: number;
}

/** The gate vocabulary. Kept as a union so a typo is a compile error. */
export type GateName =
  // single-qubit
  | 'h'
  | 'x'
  | 'y'
  | 'z'
  | 's'
  | 'sdg'
  | 't'
  | 'tdg'
  | 'rx'
  | 'ry'
  | 'rz'
  // two-qubit
  | 'cnot'
  | 'cz'
  | 'swap';

/** Below this an amplitude is treated as zero. */
const EPS = 1e-9;
/** How far two probabilities may differ and still count as equal. */
export const TOLERANCE = 1e-6;

/** Gates that carry a rotation angle. */
const PARAMETRIC: ReadonlySet<GateName> = new Set<GateName>(['rx', 'ry', 'rz']);

/** Gates that need a second qubit. */
const TWO_QUBIT: ReadonlySet<GateName> = new Set<GateName>(['cnot', 'cz', 'swap']);

/**
 * Gates whose 2x2 matrix has only real entries.
 *
 * H, X, Z and RY qualify; Y, S, Sdg, T and RZ do not (Y and S/T carry i, and RZ
 * is diag(e^-it/2, e^+it/2) rather than a rotation — putting RZ on this list is
 * an easy and silent way to break phase, so it is deliberately absent). Real
 * gates take a cheaper path that skips the per-amplitude object churn.
 */
const REAL_1Q: ReadonlySet<GateName> = new Set<GateName>(['h', 'x', 'z', 'ry']);

/**
 * One gate application.
 *
 * `qubit` is 0-based. For a two-qubit gate `target` is the partner qubit, also
 * 0-based — for `cnot` it is the target (flipped when control is 1), for `cz`
 * and `swap` the pairing is symmetric.
 */
export interface Gate {
  gate: GateName;
  qubit: number;
  target?: number;
  /** Radians. Only read for rx/ry/rz. */
  angle?: number;
}

/** A whole circuit: how many qubits, and what to apply to them, in order. */
export interface Circuit {
  qubits: number;
  gates: Gate[];
}

/** What a simulation hands back. Both views come from one pass. */
export interface SimulationResult {
  /** The final state vector, length 2^n, index = basis state in binary. */
  amplitudes: Amplitude[];
  /** |amplitudes[k]|^2, length 2^n. Sums to 1. */
  probabilities: number[];
  /** True when the state cannot be written as a product of independent qubits. */
  entangled: boolean;
}

// ─── complex helpers ─────────────────────────────────────────────────────────

const add = (a: Amplitude, b: Amplitude): Amplitude => ({
  re: a.re + b.re,
  im: a.im + b.im,
});

/** Scalar multiply — used for the sign flip in a controlled-Z. */
const scale = (a: Amplitude, k: number): Amplitude => ({ re: a.re * k, im: a.im * k });

/** (a + i b)(c + i d) = (ac - bd) + i(ad + bc) */
const mul = (a: Amplitude, b: Amplitude): Amplitude => ({
  re: a.re * b.re - a.im * b.im,
  im: a.re * b.im + a.im * b.re,
});

const ZERO: Amplitude = { re: 0, im: 0 };
const ONE: Amplitude = { re: 1, im: 0 };
const I: Amplitude = { re: 0, im: 1 };

/** Wraps into [0, 2pi) so a slider dragged round twice still means one turn. */
const mod2pi = (a: number): number => {
  const r = a % (2 * Math.PI);
  return r < 0 ? r + 2 * Math.PI : r;
};

// ─── gate matrices ───────────────────────────────────────────────────────────

/** Row-major 2x2 [[a,b],[c,d]], all entries real. */
type Matrix2 = [number, number, number, number];

/** Row-major 2x2 with complex entries. */
type MatrixC2 = [Amplitude, Amplitude, Amplitude, Amplitude];

const INV_SQRT2 = 1 / Math.sqrt(2);

const REAL_MATRICES: Partial<Record<GateName, Matrix2>> = {
  h: [INV_SQRT2, INV_SQRT2, INV_SQRT2, -INV_SQRT2],
  x: [0, 1, 1, 0],
  z: [1, 0, 0, -1],
};

/** The complex 2x2 for any single-qubit gate, real or not. */
function matrix1(name: GateName, angle: number): MatrixC2 {
  switch (name) {
    case 'h':
    case 'x':
    case 'z':
    case 'ry':
      throw new Error(`matrix1 is for complex gates; "${name}" has a real matrix.`);
    case 'y':
      // [[0, -i], [i, 0]]
      return [ZERO, scale(I, -1), I, ZERO];
    case 's':
      // diag(1, i)
      return [ONE, ZERO, ZERO, I];
    case 'sdg':
      return [ONE, ZERO, ZERO, scale(I, -1)];
    case 't':
      // diag(1, e^(i*pi/4)) = diag(1, (1+i)/sqrt2)
      return [ONE, ZERO, ZERO, { re: INV_SQRT2, im: INV_SQRT2 }];
    case 'tdg':
      // diag(1, e^(-i*pi/4)). T's inverse, so T then Tdg is the identity.
      return [ONE, ZERO, ZERO, { re: INV_SQRT2, im: -INV_SQRT2 }];
    case 'rx': {
      // [[cos, -i sin], [-i sin, cos]] with c = cos(t/2), s = sin(t/2)
      const c = Math.cos(angle / 2);
      const s = Math.sin(angle / 2);
      return [
        { re: c, im: 0 },
        { re: 0, im: -s },
        { re: 0, im: -s },
        { re: c, im: 0 },
      ];
    }
    case 'ry': {
      // [[cos, -sin], [sin, cos]] — real, so the fast path takes this
      const c = Math.cos(angle / 2);
      const s = Math.sin(angle / 2);
      return [
        { re: c, im: 0 },
        { re: -s, im: 0 },
        { re: s, im: 0 },
        { re: c, im: 0 },
      ];
    }
    case 'rz': {
      // diag(e^(-i*t/2), e^(+i*t/2)) — a phase, NOT the real rotation
      const c = Math.cos(angle / 2);
      const s = Math.sin(angle / 2);
      return [
        { re: c, im: -s },
        ZERO,
        ZERO,
        { re: c, im: s },
      ];
    }
    default:
      throw new Error(`"${name}" is not a single-qubit gate.`);
  }
}

/** The real 2x2 for a gate on the fast path. */
function matrix1Real(name: GateName, angle: number): Matrix2 {
  if (name === 'ry') {
    const c = Math.cos(angle / 2);
    const s = Math.sin(angle / 2);
    return [c, -s, s, c];
  }
  const m = REAL_MATRICES[name];
  if (!m) throw new Error(`"${name}" has no real matrix.`);
  return m;
}

// ─── state helpers ───────────────────────────────────────────────────────────

/** |00...0> — amplitude 1 on index 0. */
export function initialState(qubits: number): Amplitude[] {
  const state: Amplitude[] = new Array(2 ** qubits).fill(ZERO);
  state[0] = ONE;
  return state;
}

/** |psi[k]|^2 for every basis index. */
export function probabilityOf(state: Amplitude[]): number[] {
  return state.map((a) => a.re * a.re + a.im * a.im);
}

/** Basis index rendered as a ket, e.g. 5 -> "|101>" for 3 qubits. */
export function basisLabel(index: number, qubits: number): string {
  return `|${index.toString(2).padStart(qubits, '0')}⟩`;
}

/**
 * The bit of `index` belonging to `qubit`.
 *
 * Qubit 0 is the MOST significant bit, so index 2 in a 2-qubit register reads
 * "|10>" — qubit 0 on the left. That matches how the playground draws the wires
 * (qubit 0 on top, left to right) and how every quantum textbook labels a
 * state, so a ket string and the diagram above it always agree. The flip side
 * is that "the LSB is qubit 0", which is what a C-array-minded reader expects,
 * is deliberately not what happens here.
 */
const bitOf = (index: number, qubit: number, qubits: number): number =>
  (index >> (qubits - 1 - qubit)) & 1;

/**
 * The bit mask for `qubit` — XOR it into an index to flip just that qubit.
 *
 * Must agree with `bitOf`'s MSB convention. A CNOT that reads the control at
 * one bit position and flips the target at another looks correct on paper and
 * sends every amplitude to the wrong basis state.
 */
const bitMask = (qubit: number, qubits: number): number => 1 << (qubits - 1 - qubit);

// ─── entanglement ────────────────────────────────────────────────────────────

/**
 * Whether `state` can be written as a product of independent qubits.
 *
 * Exact, not heuristic. The test: a state is a product state iff there is some
 * split of the qubits into two non-empty groups such that, viewed as a matrix
 * with one group's bits as the row index and the other's as the column index,
 * every 2x2 minor vanishes (rank <= 1). An entangled state has rank > 1 under
 * *every* split. One-qubit states have no split and are always product states.
 *
 * Getting this right matters more than its cost: this boolean is what Athena
 * uses to tell a student "no entanglement yet" after they move a gate. A wrong
 * answer there teaches the exact opposite of the lesson. It costs 2^n-2 splits
 * of a matrix no larger than 8x8 — irrelevant at n<=4.
 */
export function isEntangled(state: Amplitude[], qubits: number): boolean {
  const size = state.length;
  if (size < 4) return false; // 0 or 1 qubit — never entangled

  // Every non-empty proper subset of qubits is one candidate split.
  for (let mask = 1; mask < size - 1; mask += 1) {
    if (allMinorsVanish(state, mask)) return false;
  }
  return true;
}

/**
 * Whether the reshape by `mask` (rows = bits in mask, cols = bits outside) has
 * rank <= 1, judged by every 2x2 minor being zero.
 *
 * The row and column indices are *compact* — row 3 of a 2-bit row group is
 * "both row bits set", whichever scattered bit positions those happen to be.
 * Turning a compact index back into a basis index therefore needs a scatter,
 * not a mask: `r & mask` silently collapses distinct rows onto each other and
 * makes every minor vanish, which reports every state as a product state.
 */
function allMinorsVanish(state: Amplitude[], mask: number): boolean {
  const rowBits: number[] = [];
  const colBits: number[] = [];
  for (let b = 0; 1 << b < state.length; b += 1) {
    if (mask & (1 << b)) rowBits.push(b);
    else colBits.push(b);
  }

  /** Compact index -> basis index, spreading bit i of `compact` onto bits[i]. */
  const scatter = (compact: number, bits: number[]): number => {
    let k = 0;
    for (let i = 0; i < bits.length; i += 1) if ((compact >> i) & 1) k |= 1 << bits[i]!;
    return k;
  };

  const rows = 1 << rowBits.length;
  const cols = 1 << colBits.length;
  // Both scatters only ever set bits below log2(state.length), so the index is
  // in range by construction — hence the assertion rather than a guard.
  const at = (r: number, c: number): Amplitude =>
    state[scatter(r, rowBits) | scatter(c, colBits)]!;

  for (let i1 = 0; i1 < rows; i1 += 1) {
    for (let i2 = i1 + 1; i2 < rows; i2 += 1) {
      for (let j1 = 0; j1 < cols; j1 += 1) {
        for (let j2 = j1 + 1; j2 < cols; j2 += 1) {
          const a = mul(at(i1, j1), at(i2, j2));
          const b = mul(at(i1, j2), at(i2, j1));
          if (Math.hypot(a.re - b.re, a.im - b.im) > EPS) return false;
        }
      }
    }
  }
  return true;
}

// ─── gate application ────────────────────────────────────────────────────────

/**
 * The step between indices that differ only in `qubit`'s bit.
 *
 * Qubit 0 is the most significant bit, so its stride is 2^(n-1) — half the
 * vector, not 1. Getting this wrong silently applies a gate to the wrong wire
 * while every probability sum still totals 1, which is why the tests assert on
 * specific basis states rather than just on normalization.
 */
const strideOf = (qubit: number, qubits: number): number => bitMask(qubit, qubits);

/** Applies a real 2x2 to every (bit=0, bit=1) pair of `qubit`. */
function applySingleReal(
  state: Amplitude[],
  qubit: number,
  m: Matrix2,
  qubits: number,
): Amplitude[] {
  const next = state.slice();
  const stride = strideOf(qubit, qubits);
  for (let base = 0; base < state.length; base += stride * 2) {
    for (let off = 0; off < stride; off += 1) {
      const i0 = base + off;
      const i1 = i0 + stride;
      // i1 < state.length because `base` steps by 2*stride and `off` < stride.
      const a = state[i0]!;
      const b = state[i1]!;
      next[i0] = { re: m[0] * a.re + m[1] * b.re, im: m[0] * a.im + m[1] * b.im };
      next[i1] = { re: m[2] * a.re + m[3] * b.re, im: m[2] * a.im + m[3] * b.im };
    }
  }
  return next;
}

function applySingleComplex(
  state: Amplitude[],
  qubit: number,
  m: MatrixC2,
  qubits: number,
): Amplitude[] {
  const next = state.slice();
  const stride = strideOf(qubit, qubits);
  for (let base = 0; base < state.length; base += stride * 2) {
    for (let off = 0; off < stride; off += 1) {
      const i0 = base + off;
      const i1 = i0 + stride;
      const a = state[i0]!;
      const b = state[i1]!;
      next[i0] = add(mul(m[0], a), mul(m[1], b));
      next[i1] = add(mul(m[2], a), mul(m[3], b));
    }
  }
  return next;
}

/** Controlled flip: for every index where `control` is 1, swap the target bit. */
function applyControlled(
  state: Amplitude[],
  control: number,
  target: number,
  qubits: number,
): Amplitude[] {
  const next = state.slice();
  const targetMask = bitMask(target, qubits);
  for (let k = 0; k < state.length; k += 1) {
    if (bitOf(k, control, qubits) === 1) next[k ^ targetMask] = state[k]!;
  }
  return next;
}

/** Controlled phase: flip the sign of every amplitude with both bits set. */
function applyControlledZ(
  state: Amplitude[],
  control: number,
  target: number,
  qubits: number,
): Amplitude[] {
  const next = state.slice();
  for (let k = 0; k < state.length; k += 1) {
    if (bitOf(k, control, qubits) === 1 && bitOf(k, target, qubits) === 1) {
      next[k] = scale(state[k]!, -1);
    }
  }
  return next;
}

/** Exchange the two qubits. */
function applySwap(state: Amplitude[], a: number, b: number, qubits: number): Amplitude[] {
  const next = state.slice();
  const flip = bitMask(a, qubits) ^ bitMask(b, qubits);
  for (let k = 0; k < state.length; k += 1) {
    if (bitOf(k, a, qubits) !== bitOf(k, b, qubits)) next[k ^ flip] = state[k]!;
  }
  return next;
}

// ─── the public entry point ──────────────────────────────────────────────────

/** How many qubits this simulator will accept. See the header for why. */
export const MAX_QUBITS = 4;

const inRange = (qubit: number, qubits: number): boolean =>
  Number.isInteger(qubit) && qubit >= 0 && qubit < qubits;

/** True if this simulator can run `circuit` at all. */
export function canSimulate(circuit: Circuit): boolean {
  return (
    Number.isInteger(circuit.qubits) &&
    circuit.qubits >= 1 &&
    circuit.qubits <= MAX_QUBITS &&
    circuit.gates.every((g) => inRange(g.qubit, circuit.qubits))
  );
}

/**
 * Runs `circuit` and returns its final state.
 *
 * Gates apply left to right, in array order — the order they appear in the
 * playground's columns. That ordering is the entire lesson of the Bell state,
 * so nothing downstream may paper over it.
 *
 * Throws on an unsupported circuit rather than returning a wrong vector: a
 * silently-wrong state would have Athena confidently tell a student their
 * circuit entangles when it does not.
 */
export function simulate(circuit: Circuit): SimulationResult {
  if (!canSimulate(circuit)) {
    throw new Error(
      `Cannot simulate a ${circuit.qubits}-qubit circuit with ` +
        `${circuit.gates.length} gates (supported: 1-${MAX_QUBITS} qubits, ` +
        `every qubit index in range).`,
    );
  }

  let state = initialState(circuit.qubits);

  for (const g of circuit.gates) {
    if (TWO_QUBIT.has(g.gate)) {
      const target = g.target;
      if (target === undefined || !inRange(target, circuit.qubits) || target === g.qubit) {
        throw new Error(`Gate "${g.gate}" on qubit ${g.qubit} needs a distinct target qubit.`);
      }
      if (g.gate === 'cnot') {
        state = applyControlled(state, g.qubit, target, circuit.qubits);
      } else if (g.gate === 'cz') {
        state = applyControlledZ(state, g.qubit, target, circuit.qubits);
      } else {
        state = applySwap(state, g.qubit, target, circuit.qubits);
      }
      continue;
    }

    // Normalize first: a student dragging a rotation slider can land past 2pi.
    const theta = PARAMETRIC.has(g.gate) ? mod2pi(g.angle ?? 0) : 0;
    if (!Number.isFinite(theta)) {
      throw new Error(`Gate "${g.gate}" on qubit ${g.qubit} needs a finite angle in radians.`);
    }
    state = REAL_1Q.has(g.gate)
      ? applySingleReal(state, g.qubit, matrix1Real(g.gate, theta), circuit.qubits)
      : applySingleComplex(state, g.qubit, matrix1(g.gate, theta), circuit.qubits);
  }

  return {
    amplitudes: state,
    probabilities: probabilityOf(state),
    entangled: isEntangled(state, circuit.qubits),
  };
}

/**
 * The state after the first `count` gates — for step-throughs, where the
 * playground shows the bar chart growing one column at a time.
 */
export function simulateSteps(circuit: Circuit): SimulationResult[] {
  if (!canSimulate(circuit)) {
    throw new Error(
      `Cannot simulate a ${circuit.qubits}-qubit circuit (supported: 1-${MAX_QUBITS} qubits).`,
    );
  }
  const out: SimulationResult[] = [];
  for (let i = 0; i <= circuit.gates.length; i += 1) {
    out.push(simulate({ qubits: circuit.qubits, gates: circuit.gates.slice(0, i) }));
  }
  return out;
}

// ─── measurement ─────────────────────────────────────────────────────────────

/**
 * Samples one measurement outcome from the distribution.
 *
 * `random` is a parameter rather than a call to `Math.random` so a test can pin
 * the draw and a replayed walkthrough reproduces exactly.
 */
export function sampleOutcome(
  result: SimulationResult,
  random: () => number = Math.random,
): number {
  const target = random();
  let cumulative = 0;
  for (let k = 0; k < result.probabilities.length; k += 1) {
    cumulative += result.probabilities[k]!;
    if (cumulative > target) return k;
  }
  return result.probabilities.length - 1;
}

/**
 * Collapses `state` onto one measured basis state and renormalises.
 *
 * Only needed for step-throughs that keep running after a mid-circuit measure;
 * a circuit that measures at the very end just reads `probabilities` directly.
 */
export function collapse(state: Amplitude[], outcome: number): Amplitude[] {
  const kept = state.map((a, k) => (k === outcome ? a : ZERO));
  const norm = Math.sqrt(kept.reduce((sum, a) => sum + a.re * a.re + a.im * a.im, 0));
  if (norm < EPS) return state.slice();
  return kept.map((a) => ({ re: a.re / norm, im: a.im / norm }));
}

// ─── comparison (used for grading) ───────────────────────────────────────────

/**
 * Do two results agree to within `tolerance` on every basis state?
 *
 * The grading primitive: "build a Bell state" is answered by running the
 * student's circuit and asking this, rather than by matching multiple-choice
 * letters. Phase is ignored — |psi> and -|psi> are the same physical state, so
 * comparing amplitudes element-wise would mark half the correct answers wrong.
 */
export function matches(a: SimulationResult, b: SimulationResult, tolerance = TOLERANCE): boolean {
  if (a.probabilities.length !== b.probabilities.length) return false;
  return a.probabilities.every((p, i) => Math.abs(p - b.probabilities[i]!) <= tolerance);
}

/**
 * True if `result` is one of the four Bell states: exactly two outcomes of equal
 * weight, bitwise complements of each other (|00>+|11> or |01>+|10>), with the
 * two amplitudes in phase or exactly out of phase.
 *
 * The phase check is what makes this a grading predicate rather than a
 * probability histogram. (|00> + i|11>)/sqrt2 is maximally entangled and has
 * identical probabilities to Phi+, but it is not a Bell state — a student who
 * adds a stray T gate has built something else and should be told so.
 */
export function isBellState(result: SimulationResult, tolerance = TOLERANCE): boolean {
  const significant = result.probabilities
    .map((p, k) => ({ p, k }))
    .filter(({ p }) => p > tolerance);
  const [first, second] = significant;
  if (!first || !second || significant.length !== 2) return false;
  if (Math.abs(first.p - 0.5) > tolerance) return false;
  if (Math.abs(second.p - 0.5) > tolerance) return false;
  // The two must differ in every qubit, i.e. be bitwise complements.
  const xor = first.k ^ second.k;
  const qubits = Math.log2(result.probabilities.length);
  for (let q = 0; q < qubits; q += 1) {
    if (((xor >> q) & 1) !== 1) return false;
  }
  // Collinear in the complex plane: the cross product vanishes iff the two
  // amplitudes share an argument up to a sign, which is what "+/-" in
  // (|00> +/- |11>)/sqrt2 means. A global phase cancels out of this test.
  const a = result.amplitudes[first.k]!;
  const b = result.amplitudes[second.k]!;
  return Math.abs(a.re * b.im - a.im * b.re) <= tolerance;
}
