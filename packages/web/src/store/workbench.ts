import { create } from 'zustand';
import { ALL_HARNESS_IDS } from '@crosscode/shared';
import type {
  ActiveTaskState,
  AgentMode,
  HarnessId,
  NormalizedAgentError,
  SharedSkillMeta,
  UnifiedProject,
  UnifiedStreamEvent,
} from '@crosscode/shared';
import { estimateTokens, foldEventIntoTimeline, nextItemId, type TimelineItem } from './event-fold';
export type {
  TimelineItem,
  TimelineUserPrompt,
  TimelineThinking,
  TimelineMessage,
  TimelineToolStep,
  TimelineFileChange,
  TimelineErrorItem,
  TimelineHarnessSwitch,
  TimelineSystemNote,
} from './event-fold';
import { buildDemoData, demoReplyFor } from './demo';
import type { ApprovalCard, ConnectionMode, InspectorTab, MobilePane, ScreenFrameView, WsStatus } from './model';
import { HARNESS_META } from '../lib/harness';
import { toDiffSummaryView, type DiffSummaryView } from '../lib/diff';
import type { DaemonApiClient, ProviderCatalogEntry } from '../api/client';
import type { SessionTransport } from '../api/ws-client';

/**
 * Central workbench store (Zustand): connection state, project matrix, the
 * folded session timeline, pending approvals, skills, diff and panel UI state.
 * Components stay dumb — everything mutates through these actions.
 */

export interface TokenUsage {
  prompt: number;
  completion: number;
}

export interface BrainState {
  memoryMd: string | null;
  activeTask: ActiveTaskState | null;
}

export interface WorkbenchData {
  mode: ConnectionMode;
  demoNotice: string | null;
  wsStatus: WsStatus;
  reconnectAttempt: number;
  jwt: string | null;
  latencyMs: number | null;
  tokenUsage: TokenUsage;
  api: DaemonApiClient | null;
  transport: SessionTransport | null;
  projects: UnifiedProject[];
  activeProjectId: string | null;
  providers: ProviderCatalogEntry[];
  agentMode: AgentMode;
  sessionId: string | null;
  timeline: TimelineItem[];
  screenFrames: ScreenFrameView[];
  approvals: ApprovalCard[];
  errors: NormalizedAgentError[];
  lastPrompt: string | null;
  skills: Record<string, boolean>;
  skillsUpdatedAt: string | null;
  skillMeta: SharedSkillMeta[];
  brain: BrainState;
  diff: DiffSummaryView | null;
  inspectorTab: InspectorTab;
  leftOpen: boolean;
  rightOpen: boolean;
  paletteOpen: boolean;
  mobilePane: MobilePane;
  switchboardDrawerOpen: boolean;
}

export interface WorkbenchActions {
  setMode(mode: ConnectionMode): void;
  setWsStatus(status: WsStatus): void;
  setReconnectAttempt(attempt: number): void;
  setJwt(token: string | null): void;
  clearJwt(): void;
  setLatency(ms: number): void;
  setApiClient(api: DaemonApiClient | null): void;
  setTransport(transport: SessionTransport | null): void;
  setProjects(projects: UnifiedProject[]): void;
  setActiveProject(id: string | null): void;
  setProviders(providers: ProviderCatalogEntry[]): void;
  setAgentMode(mode: AgentMode): void;
  setSession(sessionId: string | null): void;
  setSkillsState(skills: Record<string, boolean>, updatedAt: string | null): void;
  setSkillMeta(meta: SharedSkillMeta[]): void;
  setBrain(brain: BrainState): void;
  setDiff(diff: DiffSummaryView | null): void;
  setInspectorTab(tab: InspectorTab): void;
  applyStreamEvent(event: UnifiedStreamEvent): void;
  addSystemNote(text: string): void;
  addApproval(card: ApprovalCard): void;
  removeApproval(approvalId: string): void;
  respondApproval(approvalId: string, approved: boolean): void;
  sendPrompt(text: string): void;
  switchHarness(harnessId: HarnessId): Promise<void>;
  switchProvider(providerId: string): Promise<void>;
  refreshDiff(): Promise<void>;
  acceptDiff(files?: string[]): Promise<void>;
  discardDiff(files?: string[]): Promise<void>;
  toggleSkill(skillId: string): Promise<void>;
  pushNormalizedError(error: NormalizedAgentError): void;
  recoverActiveError(): void;
  enterDemoMode(reason: string): void;
  toggleLeft(): void;
  toggleRight(): void;
  setLeftOpen(open: boolean): void;
  setRightOpen(open: boolean): void;
  togglePalette(): void;
  openPalette(): void;
  closePalette(): void;
  setMobilePane(pane: MobilePane): void;
  setSwitchboardDrawerOpen(open: boolean): void;
}

export type WorkbenchState = WorkbenchData & WorkbenchActions;

/** Fallback provider order for SWITCH_PROVIDER self-healing. */
const FALLBACK_PROVIDERS = ['anthropic', 'openai', 'deepseek', 'gemini', 'openrouter', 'ollama'] as const;

function initialWorkbenchData(): WorkbenchData {
  return {
    mode: 'boot',
    demoNotice: null,
    wsStatus: 'idle',
    reconnectAttempt: 0,
    jwt: null,
    latencyMs: null,
    tokenUsage: { prompt: 0, completion: 0 },
    api: null,
    transport: null,
    projects: [],
    activeProjectId: null,
    providers: [],
    agentMode: 'build',
    sessionId: null,
    timeline: [],
    screenFrames: [],
    approvals: [],
    errors: [],
    lastPrompt: null,
    skills: {},
    skillsUpdatedAt: null,
    skillMeta: [],
    brain: { memoryMd: null, activeTask: null },
    diff: null,
    inspectorTab: 'changes',
    leftOpen: true,
    rightOpen: true,
    paletteOpen: false,
    mobilePane: 'stream',
    switchboardDrawerOpen: false,
  };
}

export const useWorkbenchStore = create<WorkbenchState>()((set, get) => ({
  ...initialWorkbenchData(),

  // --- plain setters -------------------------------------------------------
  setMode: (mode) => set({ mode }),
  setWsStatus: (status) => set({ wsStatus: status }),
  setReconnectAttempt: (attempt) => set({ reconnectAttempt: attempt }),
  setJwt: (token) => set({ jwt: token }),
  clearJwt: () => set({ jwt: null }),
  setLatency: (ms) => set({ latencyMs: ms }),
  setApiClient: (api) => set({ api }),
  setTransport: (transport) => set({ transport }),
  setProjects: (projects) => set({ projects }),
  setActiveProject: (id) => set({ activeProjectId: id }),
  setProviders: (providers) => set({ providers }),
  setAgentMode: (mode) => set({ agentMode: mode }),
  setSession: (sessionId) => set({ sessionId }),
  setSkillsState: (skills, updatedAt) => set({ skills: { ...skills }, skillsUpdatedAt: updatedAt }),
  setSkillMeta: (meta) => set({ skillMeta: meta }),
  setBrain: (brain) => set({ brain }),
  setDiff: (diff) => set({ diff }),
  setInspectorTab: (tab) => set({ inspectorTab: tab }),

  // --- stream --------------------------------------------------------------
  applyStreamEvent: (event) => {
    set((state) => {
      if (event.type === 'screen_frame') {
        const frame: ScreenFrameView = {
          imageBase64: event.imageBase64,
          mime: 'image/png',
          source: event.source,
          ...(event.width !== undefined ? { width: event.width } : {}),
          ...(event.height !== undefined ? { height: event.height } : {}),
          timestamp: event.timestamp,
        };
        return { screenFrames: [frame, ...state.screenFrames].slice(0, 12) };
      }
      if (event.type === 'text_delta' || event.type === 'thinking_delta') {
        return {
          timeline: foldEventIntoTimeline(state.timeline, event),
          tokenUsage: { ...state.tokenUsage, completion: state.tokenUsage.completion + estimateTokens(event.text) },
        };
      }
      if (event.type === 'normalized_error') {
        const incoming = event.error;
        const deduped = state.errors.filter(
          (existing) => !(existing.code === incoming.code && existing.rawMessage === incoming.rawMessage),
        );
        return {
          errors: [incoming, ...deduped].slice(0, 10),
          timeline: foldEventIntoTimeline(state.timeline, event),
        };
      }
      if (event.type === 'harness_switched') {
        return {
          timeline: foldEventIntoTimeline(state.timeline, event),
          projects: state.projects.map((project) =>
            project.id === state.activeProjectId ? { ...project, activeHarness: event.toHarness } : project,
          ),
        };
      }
      return { timeline: foldEventIntoTimeline(state.timeline, event) };
    });
  },

  addSystemNote: (text) =>
    set((state) => ({
      timeline: [...state.timeline, { kind: 'system', id: nextItemId(), text }],
    })),

  // --- approvals -----------------------------------------------------------
  addApproval: (card) =>
    set((state) =>
      card.approvalId && !state.approvals.some((existing) => existing.approvalId === card.approvalId)
        ? { approvals: [...state.approvals, card] }
        : {},
    ),
  removeApproval: (approvalId) =>
    set((state) => ({ approvals: state.approvals.filter((card) => card.approvalId !== approvalId) })),
  respondApproval: (approvalId, approved) => {
    get().transport?.respondApproval(approvalId, approved);
    // Optimistic removal; the gateway also echoes approval_resolved.
    get().removeApproval(approvalId);
  },

  // --- messaging -----------------------------------------------------------
  sendPrompt: (text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    set((state) => ({
      timeline: [...state.timeline, { kind: 'user_prompt', id: nextItemId(), text: trimmed }],
      lastPrompt: trimmed,
      tokenUsage: { ...state.tokenUsage, prompt: state.tokenUsage.prompt + estimateTokens(trimmed) },
    }));
    const { transport, mode } = get();
    if (transport) {
      transport.sendPrompt(trimmed);
    } else if (mode === 'demo') {
      const reply = demoReplyFor(trimmed);
      setTimeout(() => {
        useWorkbenchStore.setState((state) => ({ timeline: [...state.timeline, ...reply] }));
      }, 450);
    }
  },

  // --- switching (REST-backed, optimistic offline) --------------------------
  switchHarness: async (harnessId) => {
    const state = get();
    if (!state.activeProjectId) return;
    set((current) => ({
      projects: current.projects.map((project) =>
        project.id === current.activeProjectId ? { ...project, activeHarness: harnessId } : project,
      ),
    }));
    if (state.api) {
      try {
        await state.api.switchHarness(state.activeProjectId, harnessId);
      } catch (error) {
        get().addSystemNote(`Harness 切换失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    get().addSystemNote(`Harness 已切换 → ${HARNESS_META[harnessId].label}`);
  },

  switchProvider: async (providerId) => {
    const state = get();
    if (!state.activeProjectId) return;
    set((current) => ({
      projects: current.projects.map((project) =>
        project.id === current.activeProjectId ? { ...project, activeProviderId: providerId } : project,
      ),
    }));
    if (state.api) {
      try {
        await state.api.switchProvider(state.activeProjectId, providerId);
      } catch (error) {
        get().addSystemNote(`Provider 切换失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    state.transport?.switchProvider(providerId);
    get().addSystemNote(`Provider 已切换 → ${providerId}`);
  },

  refreshDiff: async () => {
    const state = get();
    if (!state.api || !state.activeProjectId) return;
    try {
      const raw = await state.api.getDiff(state.activeProjectId);
      get().setDiff(toDiffSummaryView(raw));
    } catch {
      // keep the previous diff view on failure
    }
  },

  acceptDiff: async (files) => {
    const state = get();
    const targets = files ?? state.diff?.files.filter((file) => !file.staged).map((file) => file.file) ?? [];
    if (targets.length === 0) return;
    if (state.api && state.activeProjectId) {
      try {
        await state.api.acceptDiff(state.activeProjectId, targets);
        await get().refreshDiff();
        return;
      } catch {
        return;
      }
    }
    set((current) => ({
      diff: current.diff
        ? { ...current.diff, files: current.diff.files.map((file) => (targets.includes(file.file) ? { ...file, staged: true } : file)) }
        : current.diff,
    }));
  },

  discardDiff: async (files) => {
    const state = get();
    const targets =
      files ?? state.diff?.files.filter((file) => file.status.trim() !== '??' && !file.staged).map((file) => file.file) ?? [];
    if (targets.length === 0) return;
    if (state.api && state.activeProjectId) {
      try {
        await state.api.discardDiff(state.activeProjectId, targets);
        await get().refreshDiff();
        return;
      } catch {
        return;
      }
    }
    set((current) => {
      if (!current.diff) return {};
      const remaining = current.diff.files.filter((file) => !targets.includes(file.file));
      return {
        diff: {
          ...current.diff,
          files: remaining,
          totalAdditions: remaining.reduce((sum, file) => sum + file.additions, 0),
          totalDeletions: remaining.reduce((sum, file) => sum + file.deletions, 0),
        },
        projects: current.projects.map((project) =>
          project.id === current.activeProjectId ? { ...project, pendingDiffCount: remaining.length } : project,
        ),
      };
    });
  },

  toggleSkill: async (skillId) => {
    const state = get();
    const next = !(state.skills[skillId] ?? false);
    set((current) => ({ skills: { ...current.skills, [skillId]: next }, skillsUpdatedAt: new Date().toISOString() }));
    if (state.api) {
      try {
        const result = await state.api.putSkill(skillId, next);
        get().setSkillsState(result.skills, result.updatedAt);
      } catch {
        // keep the optimistic toggle
      }
    }
  },

  // --- self-heal -------------------------------------------------------------
  pushNormalizedError: (error) =>
    set((state) => ({
      errors: [error, ...state.errors.filter((existing) => !(existing.code === error.code && existing.rawMessage === error.rawMessage))].slice(0, 10),
    })),

  recoverActiveError: () => {
    const state = get();
    const error = state.errors[0];
    if (!error) return;
    const dismiss = (): void => set((current) => ({ errors: current.errors.slice(1) }));

    switch (error.recoveryAction) {
      case 'SWITCH_PROVIDER': {
        const order = state.providers.length > 0 ? state.providers.map((provider) => provider.id) : [...FALLBACK_PROVIDERS];
        const current =
          state.projects.find((project) => project.id === state.activeProjectId)?.activeProviderId ?? order[0] ?? 'deepseek';
        const index = order.indexOf(current);
        const target =
          error.providerId && error.providerId !== current && order.includes(error.providerId)
            ? error.providerId
            : (order[(index + 1) % order.length] ?? current);
        void get().switchProvider(target);
        dismiss();
        break;
      }
      case 'SWITCH_HARNESS': {
        const currentHarness =
          state.projects.find((project) => project.id === state.activeProjectId)?.activeHarness ?? 'crosscode-native';
        const index = ALL_HARNESS_IDS.indexOf(currentHarness);
        const nextHarness = ALL_HARNESS_IDS[(index + 1) % ALL_HARNESS_IDS.length] ?? 'crosscode-native';
        void get().switchHarness(nextHarness);
        dismiss();
        break;
      }
      case 'COMPACT_CONTEXT':
        get().sendPrompt('/compact 压缩上下文：保留任务目标与关键结论');
        dismiss();
        break;
      case 'RETRY_BACKOFF':
        get().sendPrompt(state.lastPrompt ?? '继续之前的任务');
        dismiss();
        break;
      case 'AWAIT_APPROVAL':
        set({ mobilePane: 'stream', switchboardDrawerOpen: false });
        dismiss();
        break;
      case 'RESTART_PROCESS': {
        const transport = get().transport as (SessionTransport & { restart?: () => void }) | null;
        if (transport?.restart) {
          transport.restart();
        } else {
          get().addSystemNote('演示模式：已模拟重启会话进程');
        }
        dismiss();
        break;
      }
    }
  },

  // --- demo mode -------------------------------------------------------------
  enterDemoMode: (reason) => {
    const demo = buildDemoData();
    set((current) => ({
      ...current,
      mode: 'demo',
      demoNotice: reason,
      wsStatus: 'idle',
      reconnectAttempt: 0,
      transport: null,
      projects: demo.projects,
      activeProjectId: demo.projects[0]?.id ?? null,
      providers: demo.providers,
      skills: demo.skills,
      skillsUpdatedAt: demo.skillsUpdatedAt,
      skillMeta: demo.skillMeta,
      brain: demo.brain,
      diff: demo.diff,
      timeline: demo.timeline,
      approvals: demo.approvals,
      screenFrames: demo.screenFrames,
    }));
  },

  // --- UI ----------------------------------------------------------------
  toggleLeft: () => set((state) => ({ leftOpen: !state.leftOpen })),
  toggleRight: () => set((state) => ({ rightOpen: !state.rightOpen })),
  setLeftOpen: (open) => set({ leftOpen: open }),
  setRightOpen: (open) => set({ rightOpen: open }),
  togglePalette: () => set((state) => ({ paletteOpen: !state.paletteOpen })),
  openPalette: () => set({ paletteOpen: true }),
  closePalette: () => set({ paletteOpen: false }),
  setMobilePane: (pane) => set({ mobilePane: pane }),
  setSwitchboardDrawerOpen: (open) => set({ switchboardDrawerOpen: open }),
}));

/**
 * Test helper: restore the pristine data slice while keeping the action
 * closures (actions are stateless — they read through `get()`).
 */
export function resetWorkbenchStore(): void {
  const snapshot = useWorkbenchStore.getState() as unknown as Record<string, unknown>;
  const actions = Object.fromEntries(Object.entries(snapshot).filter(([, value]) => typeof value === 'function'));
  useWorkbenchStore.setState({ ...initialWorkbenchData(), ...actions } as WorkbenchState, true);
}
