'use client';

import { useCallback, useMemo, useState } from 'react';
import type {
  QuantumCircuit,
  QuantumGate,
  QuantumGateName,
  QuantumPublicState,
  QuantumVerdict,
  Role,
} from '@echosphere/shared-types';
import { orchestratorClient } from '@/lib/orchestrator';

interface QuantumPlaygroundProps {
  sessionId: string;
  participantId: string;
  role: Role;
  /** Authoritative state from the orchestrator. Never computed here. */
  quantum: QuantumPublicState | null;
  /** Newest first. Only the teacher sees more than their own. */
  verdicts?: QuantumVerdict[];
  lessons?: Array<{ id: string; title: string; summary: string }>;
}

/**
 * The gates a student can place, in the order they are taught.
 *
 * Deliberately shorter than the simulator's gate set: RX/RY/RZ need an angle
 * input, and a rotation slider on the first screen a fourteen-year-old sees is
 * a way to lose them before Hadamard has landed. The simulator supports them
 * for Athena-authored circuits; the palette does not offer them yet.
 */
const PALETTE: Array<{ gate: QuantumGateName; label: string; hint: string; twoQubit?: boolean }> = [
  { gate: 'h', label: 'H', hint: 'Hadamard — puts a qubit into an even superposition' },
  { gate: 'x', label: 'X', hint: 'NOT — flips 0 and 1' },
  { gate: 'z', label: 'Z', hint: 'Phase flip — changes sign, not probability' },
  { gate: 'cnot', label: '⊕', hint: 'CNOT — flips the target when the control is 1', twoQubit: true },
  { gate: 'cz', label: 'CZ', hint: 'Controlled-Z — flips the sign when both are 1', twoQubit: true },
  { gate: 'swap', label: '⇄', hint: 'SWAP — exchanges two qubits', twoQubit: true },
];

/** How a gate reads on the wire diagram. */
function gateLabel(gate: QuantumGate): string {
  const found = PALETTE.find((p) => p.gate === gate.gate);
  return found?.label ?? gate.gate.toUpperCase();
}

export default function QuantumPlayground({
  sessionId,
  participantId,
  role,
  quantum,
  verdicts = [],
  lessons = [],
}: QuantumPlaygroundProps) {
  const isTeacher = role === 'teacher';
  /**
   * The student's own working circuit, separate from the shared one.
   *
   * A student experimenting must not overwrite the board the teacher is
   * explaining from, and the teacher stepping through a lesson must not wipe
   * out the answer a student is halfway through building. Two circuits, one
   * screen — the shared one is read-only for students.
   */
  const [draft, setDraft] = useState<QuantumCircuit>({ qubits: 2, gates: [] });
  const [selected, setSelected] = useState<number>(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const challenge = quantum?.challenge ?? null;
  /** Students build against the challenge; with none open they watch the board. */
  const editing = challenge !== null || isTeacher;

  const myVerdict = useMemo(
    () => verdicts.find((v) => v.participantId === participantId) ?? null,
    [verdicts, participantId],
  );

  const addGate = useCallback(
    (gate: QuantumGateName, twoQubit: boolean) => {
      setError(null);
      setDraft((prev) => {
        if (twoQubit && prev.qubits < 2) return prev;
        const control = Math.min(selected, prev.qubits - 1);
        // The target is the next wire down, wrapping — with two qubits there is
        // only one choice, and with three the wrap keeps every control usable
        // without asking the student to pick a second wire before they know
        // what a control is.
        const target = (control + 1) % prev.qubits;
        return {
          ...prev,
          gates: [
            ...prev.gates,
            twoQubit ? { gate, qubit: control, target } : { gate, qubit: control },
          ],
        };
      });
    },
    [selected],
  );

  const undo = useCallback(() => {
    setDraft((prev) => ({ ...prev, gates: prev.gates.slice(0, -1) }));
  }, []);

  const clear = useCallback(() => {
    setDraft((prev) => ({ ...prev, gates: [] }));
  }, []);

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await orchestratorClient.runQuantumCircuit(sessionId, participantId, draft);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not run that circuit');
    } finally {
      setBusy(false);
    }
  }, [sessionId, participantId, draft]);

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await orchestratorClient.submitQuantumCircuit(sessionId, participantId, draft);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not submit that circuit');
    } finally {
      setBusy(false);
    }
  }, [sessionId, participantId, draft]);

  const step = useCallback(
    async (delta: 1 | -1) => {
      setBusy(true);
      try {
        await orchestratorClient.stepQuantumLesson(sessionId, participantId, delta);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not advance the lesson');
      } finally {
        setBusy(false);
      }
    },
    [sessionId, participantId],
  );

  const startLesson = useCallback(
    async (lessonId: string) => {
      setBusy(true);
      try {
        await orchestratorClient.startQuantumLesson(sessionId, participantId, lessonId);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not start that lesson');
      } finally {
        setBusy(false);
      }
    },
    [sessionId, participantId],
  );

  if (!quantum?.open) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-[var(--eco-cream-faint)]">
        The quantum playground is closed. The teacher can open it from the tools bag.
      </div>
    );
  }

  const shown = quantum.circuit;
  const result = quantum.result;

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
      {/* ── the shared board ───────────────────────────────────────────── */}
      <section>
        <header className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-[var(--eco-cream)]">
            {quantum.lessonId ? 'Walkthrough' : 'Shared circuit'}
          </h3>
          {quantum.lessonId && isTeacher && (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void step(-1)}
                disabled={busy}
                className="rounded-md border border-[var(--eco-rule)] bg-[var(--eco-ink-sunken)] font-medium text-[var(--eco-cream)] transition hover:bg-[color-mix(in_srgb,var(--eco-cream)_8%,var(--eco-ink-sunken))] disabled:opacity-40 px-3 py-1 text-xs"
              >
                ← Back
              </button>
              <button
                type="button"
                onClick={() => void step(1)}
                disabled={busy}
                className="rounded-md bg-[color-mix(in_srgb,var(--eco-athena)_20%,transparent)] font-semibold text-[var(--eco-athena)] ring-1 ring-[color-mix(in_srgb,var(--eco-athena)_40%,transparent)] transition hover:bg-[color-mix(in_srgb,var(--eco-athena)_30%,transparent)] disabled:opacity-40 px-3 py-1 text-xs"
              >
                Next gate →
              </button>
            </div>
          )}
        </header>

        <CircuitDiagram circuit={shown} />

        {quantum.narration && (
          <p className="mt-3 rounded-lg border border-[var(--eco-rule)] bg-[var(--eco-ink-sunken)] p-3 text-sm leading-relaxed text-[var(--eco-cream)]">
            {quantum.narration}
          </p>
        )}

        {result && <ProbabilityBars result={result} />}
      </section>

      {/* ── lesson picker, teacher only ───────────────────────────────── */}
      {isTeacher && lessons.length > 0 && !challenge && (
        <section>
          <h3 className="mb-2 text-sm font-semibold text-[var(--eco-cream)]">Guided walkthroughs</h3>
          <div className="flex flex-wrap gap-2">
            {lessons.map((l) => (
              <button
                key={l.id}
                type="button"
                onClick={() => void startLesson(l.id)}
                disabled={busy}
                title={l.summary}
                className={`rounded-md border border-[var(--eco-rule)] bg-[var(--eco-ink-sunken)] font-medium text-[var(--eco-cream)] transition hover:bg-[color-mix(in_srgb,var(--eco-cream)_8%,var(--eco-ink-sunken))] disabled:opacity-40 px-3 py-1.5 text-xs ${
                  quantum.lessonId === l.id ? 'ring-1 ring-[var(--eco-athena)]' : ''
                }`}
              >
                {l.title}
              </button>
            ))}
          </div>
        </section>
      )}

      {/* ── the challenge ─────────────────────────────────────────────── */}
      {challenge && (
        <section className="rounded-lg border border-[var(--eco-athena)] bg-[color-mix(in_srgb,var(--eco-athena)_10%,transparent)] p-3">
          <p className="text-sm font-medium text-[var(--eco-cream)]">{challenge.prompt}</p>
          {myVerdict && (
            <p
              className={`mt-2 text-sm ${
                myVerdict.correct ? 'text-[var(--eco-green)]' : 'text-[var(--eco-amber)]'
              }`}
            >
              {myVerdict.correct ? '✓ ' : ''}
              {myVerdict.feedback}
            </p>
          )}
        </section>
      )}

      {/* ── the student's own workbench ───────────────────────────────── */}
      {editing && (
        <section>
          <h3 className="mb-2 text-sm font-semibold text-[var(--eco-cream)]">
            {isTeacher ? 'Your circuit' : 'Your answer'}
          </h3>

          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-xs text-[var(--eco-cream-faint)]">Wire:</span>
            {Array.from({ length: draft.qubits }, (_, q) => (
              <button
                key={q}
                type="button"
                onClick={() => setSelected(q)}
                className={`rounded px-2 py-1 font-mono text-xs ${
                  selected === q
                    ? 'bg-[var(--eco-athena)] text-black'
                    : 'rounded-md border border-[var(--eco-rule)] bg-[var(--eco-ink-sunken)] font-medium text-[var(--eco-cream)] transition hover:bg-[color-mix(in_srgb,var(--eco-cream)_8%,var(--eco-ink-sunken))] disabled:opacity-40'
                }`}
              >
                q{q}
              </button>
            ))}
          </div>

          <div className="mb-3 flex flex-wrap gap-2">
            {PALETTE.map((p) => (
              <button
                key={p.gate}
                type="button"
                title={p.hint}
                onClick={() => addGate(p.gate, p.twoQubit === true)}
                disabled={p.twoQubit === true && draft.qubits < 2}
                className="rounded-md border border-[var(--eco-rule)] bg-[var(--eco-ink-sunken)] font-medium text-[var(--eco-cream)] transition hover:bg-[color-mix(in_srgb,var(--eco-cream)_8%,var(--eco-ink-sunken))] disabled:opacity-40 min-w-[2.5rem] px-2 py-1.5 font-mono text-sm"
              >
                {p.label}
              </button>
            ))}
          </div>

          <CircuitDiagram circuit={draft} />

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={undo}
              disabled={draft.gates.length === 0}
              className="rounded-md border border-[var(--eco-rule)] bg-[var(--eco-ink-sunken)] font-medium text-[var(--eco-cream)] transition hover:bg-[color-mix(in_srgb,var(--eco-cream)_8%,var(--eco-ink-sunken))] disabled:opacity-40 px-3 py-1.5 text-xs"
            >
              Undo
            </button>
            <button
              type="button"
              onClick={clear}
              disabled={draft.gates.length === 0}
              className="rounded-md border border-[var(--eco-rule)] bg-[var(--eco-ink-sunken)] font-medium text-[var(--eco-cream)] transition hover:bg-[color-mix(in_srgb,var(--eco-cream)_8%,var(--eco-ink-sunken))] disabled:opacity-40 px-3 py-1.5 text-xs"
            >
              Clear
            </button>
            {isTeacher && (
              <button
                type="button"
                onClick={() => void run()}
                disabled={busy}
                className="rounded-md bg-[color-mix(in_srgb,var(--eco-athena)_20%,transparent)] font-semibold text-[var(--eco-athena)] ring-1 ring-[color-mix(in_srgb,var(--eco-athena)_40%,transparent)] transition hover:bg-[color-mix(in_srgb,var(--eco-athena)_30%,transparent)] disabled:opacity-40 px-3 py-1.5 text-xs"
              >
                Show the class
              </button>
            )}
            {challenge && (
              <button
                type="button"
                onClick={() => void submit()}
                disabled={busy || draft.gates.length === 0}
                className="rounded-md bg-[color-mix(in_srgb,var(--eco-athena)_20%,transparent)] font-semibold text-[var(--eco-athena)] ring-1 ring-[color-mix(in_srgb,var(--eco-athena)_40%,transparent)] transition hover:bg-[color-mix(in_srgb,var(--eco-athena)_30%,transparent)] disabled:opacity-40 px-3 py-1.5 text-xs"
              >
                Submit answer
              </button>
            )}
          </div>
        </section>
      )}

      {error && <p className="text-xs text-[var(--eco-amber)]">{error}</p>}

      {/* ── teacher's view of who has answered ────────────────────────── */}
      {isTeacher && challenge && verdicts.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-semibold text-[var(--eco-cream)]">Submissions</h3>
          <ul className="space-y-1 text-xs">
            {verdicts.map((v, i) => (
              <li key={`${v.participantId}-${i}`} className="flex items-baseline gap-2">
                <span className={v.correct ? 'text-[var(--eco-green)]' : 'text-[var(--eco-amber)]'}>
                  {v.correct ? '✓' : '✗'}
                </span>
                <span className="text-[var(--eco-cream-faint)]">{v.feedback}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/**
 * The wire diagram: one row per qubit, one column per gate.
 *
 * Drawn with divs rather than SVG because the only geometry that matters is a
 * grid, and a grid is what CSS is for — an SVG version would need its own
 * coordinate maths for something flexbox already does correctly at any width.
 */
function CircuitDiagram({ circuit }: { circuit: QuantumCircuit }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-[var(--eco-rule)] bg-[var(--eco-ink-sunken)] p-3">
      {Array.from({ length: circuit.qubits }, (_, q) => (
        <div key={q} className="flex items-center gap-1 py-1">
          <span className="w-8 shrink-0 font-mono text-xs text-[var(--eco-cream-faint)]">q{q}</span>
          <div className="relative flex flex-1 items-center">
            <div className="absolute inset-x-0 h-px bg-[var(--eco-rule)]" />
            <div className="relative flex gap-2">
              {circuit.gates.map((g, i) => {
                const onControl = g.qubit === q;
                const onTarget = g.target === q;
                if (!onControl && !onTarget) {
                  // A spacer keeps every wire's columns aligned, so gate 3 sits
                  // above gate 3 on the wire below it.
                  return <div key={i} className="h-7 w-7 shrink-0" />;
                }
                return (
                  <div
                    key={i}
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded border font-mono text-xs ${
                      onControl && g.target !== undefined
                        ? 'border-[var(--eco-athena)] bg-[var(--eco-athena)] text-black'
                        : 'border-[var(--eco-rule)] bg-[var(--eco-ink-raised)] text-[var(--eco-cream)]'
                    }`}
                    title={g.target !== undefined ? `${g.gate} q${g.qubit}→q${g.target}` : g.gate}
                  >
                    {onControl && g.target !== undefined ? '●' : gateLabel(g)}
                  </div>
                );
              })}
              {circuit.gates.length === 0 && (
                <span className="py-1 text-xs text-[var(--eco-cream-faint)]">(empty)</span>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Probability bars — the teaching surface. Labels come pre-formatted. */
function ProbabilityBars({
  result,
}: {
  result: NonNullable<QuantumPublicState['result']>;
}) {
  return (
    <div className="mt-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs text-[var(--eco-cream-faint)]">Measurement outcomes</span>
        {result.entangled && (
          <span className="rounded-full bg-[color-mix(in_srgb,var(--eco-athena)_25%,transparent)] px-2 py-0.5 text-[10px] font-medium text-[var(--eco-athena)]">
            entangled
          </span>
        )}
      </div>
      <div className="space-y-1.5">
        {result.outcomes.map((o) => (
          <div key={o.label} className="flex items-center gap-2">
            <span className="w-12 shrink-0 font-mono text-xs text-[var(--eco-cream-faint)]">
              {o.label}
            </span>
            <div className="h-4 flex-1 overflow-hidden rounded bg-[var(--eco-ink-sunken)]">
              <div
                className="h-full rounded bg-[var(--eco-athena)] transition-[width] duration-300"
                style={{ width: `${Math.round(o.probability * 100)}%` }}
              />
            </div>
            <span className="w-10 shrink-0 text-right font-mono text-xs text-[var(--eco-cream-faint)]">
              {Math.round(o.probability * 100)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
