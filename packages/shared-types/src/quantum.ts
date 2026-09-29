/**
 * The quantum playground's wire format.
 *
 * These types are the contract between three places: the orchestrator's
 * simulator (which grades), the browser (which draws), and Athena (whose JSON
 * payloads push circuits onto the screen). `Circuit` in particular is
 * structurally identical to the one in `orchestrator/src/quantum/simulator.ts`
 * — deliberately duplicated rather than imported, because the simulator is a
 * self-contained pure module with no dependency on this package, and a shared
 * type that forced it to grow one would be a worse trade than eight lines of
 * repetition. The `quantum.test.ts` suite pins the simulator's own copy; if the
 * two ever drift, the orchestrator stops compiling at the boundary.
 */

export type QuantumGateName =
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
  | 'cnot'
  | 'cz'
  | 'swap';

export interface QuantumGate {
  gate: QuantumGateName;
  /** The wire this gate sits on. For two-qubit gates, the control. */
  qubit: number;
  /** Second wire, required by cnot/cz/swap and ignored otherwise. */
  target?: number;
  /** Radians, for rx/ry/rz only. */
  angle?: number;
}

export interface QuantumCircuit {
  qubits: number;
  gates: QuantumGate[];
}

/** One basis state's share of the outcome, ready to draw as a bar. */
export interface QuantumOutcome {
  /** "|01⟩" — pre-formatted so the browser never has to know the bit order. */
  label: string;
  probability: number;
}

/**
 * What the class sees after a run.
 *
 * Amplitudes are omitted on purpose: the bars are the teaching surface, and a
 * complex vector on screen is noise for a first-time student. Anything that
 * needs phase (grading, entanglement) is decided in the orchestrator, which has
 * the full state, and arrives here as a flag.
 */
export interface QuantumResult {
  outcomes: QuantumOutcome[];
  entangled: boolean;
  /** Set when the circuit came from a lesson step rather than free play. */
  lessonId?: string;
  /** Index into the lesson's step array, when stepping through one. */
  stepIndex?: number;
}

/** A challenge the class is being asked to build. */
export interface QuantumChallenge {
  id: string;
  /** "Build a Bell state on two qubits." */
  prompt: string;
  qubits: number;
  /**
   * How the answer is checked. `bell` accepts any of the four Bell states;
   * `state` compares probabilities against `expected` after running whatever
   * the student built. Structural checks ("used exactly two gates") are
   * deliberately absent — there is more than one right circuit, and grading the
   * state instead of the gate list is the whole point of having a simulator.
   */
  check: 'bell' | 'state';
  /** Target probabilities, index-aligned to basis states. `check: 'state'` only. */
  expected?: number[];
}

/** The verdict on a submitted circuit. */
export interface QuantumVerdict {
  challengeId: string;
  participantId: string;
  correct: boolean;
  /** What the student's circuit actually produced, for the "here's why" panel. */
  result: QuantumResult;
  /** One sentence Athena can read aloud. Written by the grader, not the LLM. */
  feedback: string;
}

/** Everything a joining client needs to render the playground as it stands. */
export interface QuantumPublicState {
  open: boolean;
  circuit: QuantumCircuit;
  result: QuantumResult | null;
  /** Narration for the current step, when a lesson is being walked through. */
  narration: string | null;
  lessonId: string | null;
  stepIndex: number;
  challenge: QuantumChallenge | null;
}
