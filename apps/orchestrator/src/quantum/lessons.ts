/**
 * The guided algorithms Athena walks a class through, gate by gate.
 *
 * A lesson is just a circuit plus one line of narration per prefix — step 0 is
 * the state before anything runs, step i is the state after gate i-1. That
 * lines up exactly with `simulateSteps`, so stepping forward is an array index
 * rather than a re-simulation, and the narration can never drift out of sync
 * with the state on screen.
 *
 * The narration is written here rather than generated per-session on purpose:
 * these are the sentences that have to be *right*. "The oracle flipped the sign
 * of the marked state" is a claim about the amplitudes the student is looking
 * at, and an LLM improvising it will eventually say something false at the
 * worst possible moment. Athena reads these; she elaborates around them.
 */

import { simulateSteps, type Circuit, type SimulationResult } from './simulator';

export interface LessonStep {
  /** What the class should understand at this point. Athena reads/expands this. */
  readonly narration: string;
  /** Human label for the gate that produced this state — empty for step 0. */
  readonly gateLabel: string;
}

export interface Lesson {
  readonly id: string;
  readonly title: string;
  /** One sentence for the lesson picker. */
  readonly summary: string;
  readonly circuit: Circuit;
  /** Exactly `circuit.gates.length + 1` entries. Enforced by the tests. */
  readonly steps: readonly LessonStep[];
  /** What the student should see at the end, in plain words. */
  readonly takeaway: string;
}

// ─── the lessons ─────────────────────────────────────────────────────────────

/**
 * Entanglement, in two gates.
 *
 * The reason this is lesson one: it is the shortest circuit where the order of
 * two gates changes the physics, so a student can discover the rule by dragging
 * rather than by being told it.
 */
const BELL: Lesson = {
  id: 'bell',
  title: 'Making a Bell pair',
  summary: 'Two gates that turn two independent qubits into one inseparable pair.',
  circuit: {
    qubits: 2,
    gates: [
      { gate: 'h', qubit: 0 },
      { gate: 'cnot', qubit: 0, target: 1 },
    ],
  },
  steps: [
    {
      gateLabel: '',
      narration:
        'Both qubits start at 0, so the whole system is definitely in the state 00. One bar, full height — there is nothing random here yet.',
    },
    {
      gateLabel: 'H on q0',
      narration:
        'The Hadamard puts the first qubit into an even superposition. Now 00 and 10 are equally likely. The second qubit has not moved: it is still a plain 0, and the two qubits are still independent of each other.',
    },
    {
      gateLabel: 'CNOT q0 → q1',
      narration:
        'The CNOT flips the second qubit only in the branch where the first is 1. That welds the two branches together: 00 and 11, nothing else. Measuring either qubit now instantly tells you the other, no matter how far apart they are. That is entanglement.',
    },
  ],
  takeaway:
    'Superposition first, then the controlled gate. Run the CNOT before the Hadamard and you get a product state — same two gates, no entanglement.',
};

/**
 * Deutsch-Jozsa on one input qubit, with a balanced oracle.
 *
 * The smallest algorithm where quantum beats classical outright: one oracle call
 * instead of two. At n=1 that sounds like a rounding error, which is exactly why
 * it is teachable — the mechanism is visible, and the speedup argument scales.
 */
const DEUTSCH_JOZSA: Lesson = {
  id: 'deutsch-jozsa',
  title: 'Deutsch–Jozsa: one question instead of two',
  summary: 'Decide whether a hidden function is constant or balanced in a single oracle call.',
  circuit: {
    qubits: 2,
    gates: [
      { gate: 'x', qubit: 1 },
      { gate: 'h', qubit: 0 },
      { gate: 'h', qubit: 1 },
      { gate: 'cnot', qubit: 0, target: 1 }, // the balanced oracle f(x) = x
      { gate: 'h', qubit: 0 },
    ],
  },
  steps: [
    {
      gateLabel: '',
      narration:
        'Qubit 0 is the input we will ask about. Qubit 1 is a workspace qubit the oracle writes its answer into. Both start at 0.',
    },
    {
      gateLabel: 'X on q1',
      narration:
        'Flip the workspace qubit to 1. This is setup — the next Hadamard turns it into the minus state, which is what makes the oracle leave its mark as a phase instead of as a value.',
    },
    {
      gateLabel: 'H on q0',
      narration:
        'Put the input qubit into superposition. We are now asking about 0 and 1 at the same time — a classical computer has to pick one and run the function, then pick the other and run it again.',
    },
    {
      gateLabel: 'H on q1',
      narration:
        'The workspace qubit becomes the minus state: equal parts 0 and 1, but with a minus sign on the 1. Watch what the oracle does to it.',
    },
    {
      gateLabel: 'Oracle (CNOT) — f(x) = x',
      narration:
        'Here is the single oracle call. Because the workspace is in the minus state, flipping it does not change which outcomes are possible — it flips a sign instead. The probabilities look unchanged, and that is the point: the answer is now stored in a phase the bars cannot show you.',
    },
    {
      gateLabel: 'H on q0',
      narration:
        'The final Hadamard converts that hidden phase back into something measurable. The input qubit is now definitely 1. A 1 means balanced; a 0 would have meant constant. One oracle call, and we know.',
    },
  ],
  takeaway:
    'The oracle was called once. Classically you must evaluate f(0) and f(1) and compare them — two calls. The trick is that the answer lived in a phase, and the last Hadamard turned that phase into a bit.',
};

/**
 * Grover on two qubits, searching for |11>.
 *
 * Two qubits is the case where one iteration is exactly enough — the marked
 * state comes out with certainty, so the class sees a clean single bar rather
 * than "mostly right". The ~sqrt(N) story is told over that, not demonstrated
 * by it.
 */
const GROVER: Lesson = {
  id: 'grover',
  title: 'Grover: finding the marked item',
  summary: 'Search four possibilities in one step by amplifying the one that matters.',
  circuit: {
    qubits: 2,
    gates: [
      { gate: 'h', qubit: 0 },
      { gate: 'h', qubit: 1 },
      { gate: 'cz', qubit: 0, target: 1 }, // oracle: mark |11>
      // diffusion (inversion about the mean)
      { gate: 'h', qubit: 0 },
      { gate: 'h', qubit: 1 },
      { gate: 'x', qubit: 0 },
      { gate: 'x', qubit: 1 },
      { gate: 'cz', qubit: 0, target: 1 },
      { gate: 'x', qubit: 0 },
      { gate: 'x', qubit: 1 },
      { gate: 'h', qubit: 0 },
      { gate: 'h', qubit: 1 },
    ],
  },
  steps: [
    {
      gateLabel: '',
      narration:
        'Four possible answers — 00, 01, 10, 11 — and one of them is the one we want. We start knowing nothing, at 00.',
    },
    {
      gateLabel: 'H on q0',
      narration: 'First qubit into superposition.',
    },
    {
      gateLabel: 'H on q1',
      narration:
        'Second qubit too. All four answers are now equally likely, 25% each. This is the honest starting point for a search: no information, so no preference.',
    },
    {
      gateLabel: 'Oracle (CZ) — marks 11',
      narration:
        'The oracle recognises the answer we are looking for and flips its sign. The bars have not moved — all four are still at 25% — because a sign is invisible to a probability. The information is there, it is just not yet something you could measure.',
    },
    {
      gateLabel: 'H on q0',
      narration: 'The diffusion step begins. Hadamards first.',
    },
    { gateLabel: 'H on q1', narration: 'Both qubits transformed.' },
    { gateLabel: 'X on q0', narration: 'Now flip both qubits…' },
    {
      gateLabel: 'X on q1',
      narration:
        '…which moves 00 into the 11 slot. That matters because the only two-qubit sign-flip we have acts on 11, and the reflection we actually want is a reflection about 00.',
    },
    {
      gateLabel: 'CZ',
      narration:
        'The reflection itself. Combined with the Hadamards on either side, this whole block flips every amplitude about their average — so the one the oracle pushed below the average gets pushed furthest above it.',
    },
    { gateLabel: 'X on q0', narration: 'Undo the flips…' },
    { gateLabel: 'X on q1', narration: '…and we are almost back.' },
    { gateLabel: 'H on q0', narration: 'Final Hadamards.' },
    {
      gateLabel: 'H on q1',
      narration:
        'And there it is: all the amplitude has piled onto 11, the state the oracle marked. Four candidates, one oracle call, and the answer comes out with certainty.',
    },
  ],
  takeaway:
    'The oracle alone changes nothing you can measure. It is the diffusion step — reflecting every amplitude about the average — that turns a hidden sign into a tall bar. With four items one round is exact; with N items you need about sqrt(N) rounds, against N/2 for classical search.',
};

// ─── lookup ──────────────────────────────────────────────────────────────────

export const LESSONS: readonly Lesson[] = [BELL, DEUTSCH_JOZSA, GROVER];

export function findLesson(id: string): Lesson | undefined {
  return LESSONS.find((l) => l.id === id);
}

/**
 * The per-step states for a lesson, aligned index-for-index with `lesson.steps`.
 *
 * Kept separate from the lesson data so the narration stays a plain constant —
 * the states are derived, and deriving them twice is cheaper than keeping a
 * cached copy that can go stale when a gate is edited.
 */
export function lessonStates(lesson: Lesson): SimulationResult[] {
  return simulateSteps(lesson.circuit);
}
