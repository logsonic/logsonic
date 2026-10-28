import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

/** One tool invocation inside an agent turn. */
export type AgentStep = {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  output?: unknown;
  status: 'running' | 'done' | 'error';
};

/** Ordered pieces of an agent reply: streamed prose and tool steps interleave. */
export type AgentItem =
  | { kind: 'text'; round: number; text: string }
  | { kind: 'step'; step: AgentStep };

export type AgentTurn = {
  user: string;
  items: AgentItem[];
  /** Final answer text, set when the turn completes. */
  answer?: string;
  error?: string;
  /** True while the request is streaming. Never persisted as true. */
  pending?: boolean;
  startedAt: number;
  finishedAt?: number;
};

export type AgentSession = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  turns: AgentTurn[];
};

export const AGENT_PANEL_MIN = 340;
export const AGENT_PANEL_MAX = 760;
const AGENT_PANEL_DEFAULT = 420;
const MAX_SESSIONS = 30;

const newId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const titleFrom = (prompt: string) => {
  const line = prompt.trim().split('\n')[0];
  return line.length > 64 ? `${line.slice(0, 61).trimEnd()}…` : line;
};

interface AgentState {
  panelOpen: boolean;
  panelWidth: number;
  sessions: AgentSession[];
  activeId: string | null;
  /** id of the step whose query currently drives the log table. */
  viewStepId: string | null;

  setPanelOpen: (open: boolean) => void;
  togglePanel: () => void;
  setPanelWidth: (width: number) => void;
  newSession: () => void;
  selectSession: (id: string) => void;
  deleteSession: (id: string) => void;
  /** Append a user turn to the active session (creating one if needed). */
  startTurn: (prompt: string) => string;
  /** Replace the last turn of a session. */
  updateLastTurn: (sessionId: string, update: (turn: AgentTurn) => AgentTurn) => void;
  setViewStep: (id: string | null) => void;
}

export const useAgentStore = create<AgentState>()(
  persist(
    (set, get) => ({
      panelOpen: false,
      panelWidth: AGENT_PANEL_DEFAULT,
      sessions: [],
      activeId: null,
      viewStepId: null,

      setPanelOpen: (panelOpen) => set({ panelOpen }),
      togglePanel: () => set({ panelOpen: !get().panelOpen }),
      setPanelWidth: (width) =>
        set({
          panelWidth: Math.round(Math.max(AGENT_PANEL_MIN, Math.min(AGENT_PANEL_MAX, width))),
        }),

      newSession: () => set({ activeId: null, viewStepId: null }),
      selectSession: (id) => set({ activeId: id, viewStepId: null }),
      deleteSession: (id) =>
        set((state) => ({
          sessions: state.sessions.filter((session) => session.id !== id),
          activeId: state.activeId === id ? null : state.activeId,
        })),

      startTurn: (prompt) => {
        const now = Date.now();
        const turn: AgentTurn = { user: prompt, items: [], pending: true, startedAt: now };
        const { activeId, sessions } = get();
        const existing = activeId ? sessions.find((session) => session.id === activeId) : undefined;
        if (existing) {
          set({
            sessions: sessions.map((session) =>
              session.id === existing.id
                ? { ...session, updatedAt: now, turns: [...session.turns, turn] }
                : session
            ),
          });
          return existing.id;
        }
        const session: AgentSession = {
          id: newId(),
          title: titleFrom(prompt),
          createdAt: now,
          updatedAt: now,
          turns: [turn],
        };
        set({ sessions: [session, ...sessions].slice(0, MAX_SESSIONS), activeId: session.id });
        return session.id;
      },

      updateLastTurn: (sessionId, update) =>
        set((state) => ({
          sessions: state.sessions.map((session) => {
            if (session.id !== sessionId || session.turns.length === 0) return session;
            const turns = session.turns.slice();
            turns[turns.length - 1] = update(turns[turns.length - 1]);
            return { ...session, turns, updatedAt: Date.now() };
          }),
        })),

      setViewStep: (viewStepId) => set({ viewStepId }),
    }),
    {
      name: 'logsonic-agent',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        panelOpen: state.panelOpen,
        panelWidth: state.panelWidth,
        activeId: state.activeId,
        // A reload ends any in-flight request; persist such turns as interrupted.
        sessions: state.sessions.map((session) => ({
          ...session,
          turns: session.turns.map((turn) =>
            turn.pending
              ? {
                  ...turn,
                  pending: false,
                  error: turn.error ?? 'Interrupted before the agent finished.',
                  items: turn.items.map((item) =>
                    item.kind === 'step' && item.step.status === 'running'
                      ? { ...item, step: { ...item.step, status: 'error' as const } }
                      : item
                  ),
                }
              : turn
          ),
        })),
      }),
    }
  )
);

export const useActiveSession = () =>
  useAgentStore((state) => state.sessions.find((session) => session.id === state.activeId) ?? null);
