/**
 * The quantum playground's session state and the two directions it moves in.
 *
 * Direction one, Athena -> screen: `applyCircuit` / `startLesson` / `stepLesson`
 * take a circuit or a lesson position, simulate it here, and broadcast the
 * result. The browser never simulates — same rule as the rest of the
 * classroom, and here it also guarantees the bars a student sees are the same
 * numbers the grader used.
 *
 * Direction two, screen -> Athena: `describeForAgent` turns the current state
 * into one paragraph of plain English. That paragraph is what Athena reads, so
 * she can say "you put the CNOT before the H, so there is no entanglement yet"
 * without ever being handed an amplitude vector to misread.
 */

import type {
  QuantumChallenge,
  QuantumCircuit,
  QuantumPublicState,
  QuantumResult,
  QuantumVerdict,
} from '@echosphere/shared-types';
import { publish } from '../state/eventBus.js';
import type { ClassroomSession } from '../state/sessionRegistry.js';
import { findLesson, lessonStates } from './lessons.js';
import {
  basisLabel,
  canSimulate,
  isBellState,
  matches,
  simulate,
  MAX_QUBITS,
  type Circuit,
  type SimulationResult,
} from './simulator.js';

/** The empty board a session starts with: two wires, nothing on them. */
export function emptyQuantumState(): QuantumPublicState {
  return {
    open: false,
    circuit: { qubits: 2, gates: [] },
    result: null,
    narration: null,
    lessonId: null,
    stepIndex: 0,
    challenge: null,
  };
}

// ─── conversion ──────────────────────────────────────────────────────────────

/**
 * Simulator output -> wire format.
 *
 * Amplitudes are dropped and the basis labels are baked in here so that the
 * browser cannot get the bit order wrong — it is the one convention in this
 * module that has already caused real bugs, and the fewer places that know
 * about it, the better.
 */
function toWire(result: SimulationResult, qubits: number): QuantumResult {
  return {
    outcomes: result.probabilities.map((probability, k) => ({
      label: basisLabel(k, qubits),
      probability,
    })),
    entangled: result.entangled,
  };
}

/** Wire format -> simulator input. Structurally identical; this is the seam. */
function toCircuit(circuit: QuantumCircuit): Circuit {
  return { qubits: circuit.qubits, gates: circuit.gates as Circuit['gates'] };
}

export function publicQuantum(session: ClassroomSession): QuantumPublicState {
  return session.quantum;
}

export function broadcastQuantum(session: ClassroomSession): void {
  publish(session.sessionId, { kind: 'echosphere:quantum', state: publicQuantum(session) });
}

// ─── direction one: something puts a circuit on the screen ───────────────────

export interface CircuitRejection {
  ok: false;
  reason: string;
}

/**
 * Puts `circuit` on the screen and runs it.
 *
 * Returns a rejection rather than throwing when the circuit is unusable: the
 * two callers are an HTTP route and an LLM payload handler, and neither should
 * take down a live classroom because Athena emitted a gate on wire 7.
 */
export function applyCircuit(
  session: ClassroomSession,
  circuit: QuantumCircuit,
): { ok: true; result: QuantumResult } | CircuitRejection {
  if (!Number.isInteger(circuit.qubits) || circuit.qubits < 1 || circuit.qubits > MAX_QUBITS) {
    return { ok: false, reason: `qubits must be between 1 and ${MAX_QUBITS}` };
  }
  const parsed = toCircuit(circuit);
  if (!canSimulate(parsed)) {
    return { ok: false, reason: 'circuit references a wire that does not exist' };
  }

  const result = simulate(parsed);
  const wire = toWire(result, circuit.qubits);

  session.quantum.open = true;
  session.quantum.circuit = circuit;
  session.quantum.result = wire;
  // Free play is not a lesson position; clear the narration so a stale sentence
  // from a half-finished walkthrough cannot sit under a circuit it never described.
  session.quantum.lessonId = null;
  session.quantum.narration = null;
  session.quantum.stepIndex = 0;
  broadcastQuantum(session);
  return { ok: true, result: wire };
}

/** Opens a lesson at its first step. */
export function startLesson(
  session: ClassroomSession,
  lessonId: string,
): { ok: true } | CircuitRejection {
  const lesson = findLesson(lessonId);
  if (!lesson) return { ok: false, reason: `no lesson named "${lessonId}"` };

  session.quantum.open = true;
  session.quantum.lessonId = lesson.id;
  session.quantum.challenge = null;
  applyLessonStep(session, 0);
  return { ok: true };
}

/**
 * Moves to `stepIndex` of the open lesson. `delta` of +1/-1 covers next/back.
 *
 * Clamps rather than wrapping: a class that clicks past the end should sit on
 * the final state with the takeaway on screen, not silently restart.
 */
export function stepLesson(
  session: ClassroomSession,
  delta: number,
): { ok: true; stepIndex: number } | CircuitRejection {
  const lessonId = session.quantum.lessonId;
  if (!lessonId) return { ok: false, reason: 'no lesson is open' };
  const lesson = findLesson(lessonId);
  if (!lesson) return { ok: false, reason: `no lesson named "${lessonId}"` };

  const target = Math.max(0, Math.min(lesson.steps.length - 1, session.quantum.stepIndex + delta));
  applyLessonStep(session, target);
  return { ok: true, stepIndex: target };
}

/** Shared by start and step: set the circuit prefix, narration, and result. */
function applyLessonStep(session: ClassroomSession, stepIndex: number): void {
  const lesson = findLesson(session.quantum.lessonId ?? '');
  if (!lesson) return;

  const step = lesson.steps[stepIndex];
  const state = lessonStates(lesson)[stepIndex];
  if (!step || !state) return;

  session.quantum.stepIndex = stepIndex;
  session.quantum.narration = step.narration;
  // The circuit shown is the prefix that has actually run — showing all twelve
  // Grover gates while narrating gate three would tell the class the state on
  // screen came from a circuit it did not come from.
  session.quantum.circuit = {
    qubits: lesson.circuit.qubits,
    gates: lesson.circuit.gates.slice(0, stepIndex) as QuantumCircuit['gates'],
  };
  session.quantum.result = toWire(state, lesson.circuit.qubits);
  broadcastQuantum(session);
}

export function closeQuantum(session: ClassroomSession): void {
  session.quantum.open = false;
  broadcastQuantum(session);
}

// ─── challenges ──────────────────────────────────────────────────────────────

export function setChallenge(session: ClassroomSession, challenge: QuantumChallenge): void {
  session.quantum.open = true;
  session.quantum.challenge = challenge;
  session.quantum.lessonId = null;
  session.quantum.narration = null;
  // A fresh challenge starts from an empty board; leaving the previous answer
  // up would let the next student submit it unchanged.
  session.quantum.circuit = { qubits: challenge.qubits, gates: [] };
  session.quantum.result = null;
  broadcastQuantum(session);
}

/**
 * Grades a submitted circuit against the open challenge.
 *
 * Grading is by resulting state, never by gate list — "build a Bell state" has
 * infinitely many right answers and a student who finds an unusual one is
 * demonstrating more understanding, not less.
 */
export function gradeSubmission(
  session: ClassroomSession,
  participantId: string,
  circuit: QuantumCircuit,
): QuantumVerdict | CircuitRejection {
  const challenge = session.quantum.challenge;
  if (!challenge) return { ok: false, reason: 'no challenge is open' };

  const parsed = toCircuit(circuit);
  if (!canSimulate(parsed)) return { ok: false, reason: 'circuit is not simulatable' };

  const result = simulate(parsed);
  const wire = toWire(result, circuit.qubits);

  let correct: boolean;
  if (challenge.check === 'bell') {
    correct = circuit.qubits === challenge.qubits && isBellState(result);
  } else {
    const expected = challenge.expected;
    correct =
      circuit.qubits === challenge.qubits &&
      expected !== undefined &&
      expected.length === result.probabilities.length &&
      matches(result, { ...result, probabilities: expected });
  }

  return {
    challengeId: challenge.id,
    participantId,
    correct,
    result: wire,
    feedback: explain(challenge, circuit, result, correct),
  };
}

/**
 * The sentence the student reads, and Athena may say aloud.
 *
 * Deliberately written here rather than asked of the LLM. These are the moments
 * a learner is most likely to take the feedback literally, and "you put the
 * CNOT before the H" has to be true every single time — a model improvising it
 * from a probability list will eventually invent a mistake the student did not
 * make.
 */
function explain(
  challenge: QuantumChallenge,
  circuit: QuantumCircuit,
  result: SimulationResult,
  correct: boolean,
): string {
  if (correct) {
    return challenge.check === 'bell'
      ? 'That is a Bell state — two outcomes, equally likely, and measuring one qubit fixes the other.'
      : 'That matches the target distribution exactly.';
  }

  if (circuit.gates.length === 0) return 'Nothing has been placed on the wires yet.';

  if (challenge.check === 'bell') {
    // The specific, common mistake this module exists to catch.
    const firstTwo = circuit.gates.slice(0, 2).map((g) => g.gate);
    if (firstTwo[0] === 'cnot' && firstTwo[1] === 'h') {
      return 'The CNOT runs before the Hadamard, so it has nothing to entangle — the control is still a definite 0. Swap the two gates.';
    }
    if (!result.entangled) {
      return 'The two qubits are still independent: measuring one tells you nothing about the other. A Bell pair needs a superposition first, then a controlled gate.';
    }
    const live = result.probabilities.filter((p) => p > 1e-6).length;
    if (live !== 2) {
      return `The qubits are entangled, but ${live} outcomes are possible. A Bell state has exactly two, each at 50%.`;
    }
    return 'Close — two entangled outcomes, but not at equal weight or not in phase. A Bell state splits exactly 50/50.';
  }

  return 'That runs, but the outcome distribution is not the one we are aiming for. Compare the bars against the target.';
}

// ─── direction two: the screen tells Athena what it is showing ───────────────

/**
 * The current playground state as one paragraph of plain English.
 *
 * This is the whole screen -> Athena path. It exists because handing a language
 * model a JSON state vector and hoping it narrates correctly is exactly the
 * failure mode this module is supposed to prevent: the arithmetic is done here,
 * where it is tested, and Athena receives conclusions rather than raw numbers.
 */
export function describeForAgent(session: ClassroomSession): string {
  const q = session.quantum;
  if (!q.open) return 'The quantum playground is not currently on screen.';

  const gateList =
    q.circuit.gates.length === 0
      ? 'no gates yet'
      : q.circuit.gates
          .map((g) =>
            g.target === undefined
              ? `${g.gate.toUpperCase()} on q${g.qubit}`
              : `${g.gate.toUpperCase()} q${g.qubit}->q${g.target}`,
          )
          .join(', ');

  const parts = [`The playground shows a ${q.circuit.qubits}-qubit circuit: ${gateList}.`];

  if (q.result) {
    const live = q.result.outcomes
      .filter((o) => o.probability > 1e-6)
      .map((o) => `${o.label} at ${Math.round(o.probability * 100)}%`)
      .join(', ');
    parts.push(`Outcomes: ${live}.`);
    parts.push(
      q.result.entangled
        ? 'The qubits are entangled.'
        : 'The qubits are not entangled — the state is still a product.',
    );
  }

  if (q.lessonId) {
    const lesson = findLesson(q.lessonId);
    if (lesson) {
      parts.push(
        `This is step ${q.stepIndex + 1} of ${lesson.steps.length} in the "${lesson.title}" walkthrough.`,
      );
    }
  }

  if (q.challenge) parts.push(`The open challenge is: ${q.challenge.prompt}`);

  return parts.join(' ');
}
