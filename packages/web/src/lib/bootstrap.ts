import { DaemonApiClient, DaemonApiError } from '../api/client';
import { SessionSocket } from '../api/ws-client';
import { useWorkbenchStore } from '../store/workbench';
import { clearStoredToken, getStoredToken, setStoredToken } from './token';

/**
 * Application bootstrap wiring: REST client + WebSocket session + demo-mode
 * degradation. Runs once per page load (StrictMode-safe via `bootstrapped`).
 *
 * Flow: VITE_DEMO=1 → demo mode. Otherwise REST probe with the stored JWT —
 * 401 → PIN pairing gate; network failure → silent offline demo degradation.
 */

let bootstrapped = false;
let activeSocket: SessionSocket | null = null;

export async function bootWorkbench(): Promise<void> {
  if (bootstrapped) return;
  bootstrapped = true;

  const store = useWorkbenchStore.getState();
  if (import.meta.env.VITE_DEMO === '1') {
    store.enterDemoMode('VITE_DEMO=1 已强制进入离线演示模式');
    return;
  }

  const api = new DaemonApiClient({ onLatency: (ms) => useWorkbenchStore.getState().setLatency(ms) });
  store.setApiClient(api);

  const token = getStoredToken();
  if (!token) {
    store.setMode('offline');
    return;
  }
  store.setJwt(token);
  await connectLive(token);
}

/** Full live connection: probe REST, hydrate the matrix, open the session WS. */
export async function connectLive(token: string): Promise<void> {
  const api = useWorkbenchStore.getState().api;
  if (!api) return;
  try {
    const [projects, providers, skills] = await Promise.all([
      api.listProjects(),
      api.listProviders(),
      api.getSkills(),
    ]);
    const state = useWorkbenchStore.getState();
    state.setProjects(projects);
    state.setProviders(providers);
    state.setSkillsState(skills.skills, skills.updatedAt);
    const first = projects[0] ?? null;
    state.setActiveProject(first?.id ?? null);
    state.setMode('live');
    openSessionSocket(token, first?.path);
    if (first) void state.refreshDiff();
  } catch (error) {
    if (error instanceof DaemonApiError && error.status === 401) {
      clearStoredToken();
      const state = useWorkbenchStore.getState();
      state.setJwt(null);
      state.setMode('offline');
      return;
    }
    useWorkbenchStore
      .getState()
      .enterDemoMode(`守护进程不可达（${error instanceof Error ? error.message : String(error)}），已进入离线演示模式`);
  }
}

function openSessionSocket(token: string, projectPath?: string): void {
  const api = useWorkbenchStore.getState().api;
  if (!api) return;
  activeSocket?.close();
  activeSocket = new SessionSocket({ url: api.wsSessionUrl(projectPath), token });
  useWorkbenchStore.getState().setTransport(activeSocket);
  activeSocket.connect();
}

/** PIN pairing submit — returns a user-facing error message or null on success. */
export async function submitPairing(pin: string): Promise<string | null> {
  const api = useWorkbenchStore.getState().api;
  if (!api) return '客户端尚未初始化，请刷新页面';
  try {
    const result = await api.pair(pin);
    setStoredToken(result.token);
    const state = useWorkbenchStore.getState();
    state.setJwt(result.token);
    await connectLive(result.token);
    return null;
  } catch (error) {
    if (error instanceof DaemonApiError && (error.status === 400 || error.status === 403)) {
      return 'PIN 无效，请核对守护进程显示的 6 位配对码';
    }
    return `配对失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Reconnect the session socket when the active project changes (the gateway
 * scopes sessions by `?projectPath=`). Returns an unsubscribe function.
 */
export function watchProjectSwitch(): () => void {
  let lastProjectId = useWorkbenchStore.getState().activeProjectId;
  return useWorkbenchStore.subscribe((state) => {
    if (state.activeProjectId === lastProjectId) return;
    lastProjectId = state.activeProjectId;
    if (state.mode !== 'live' || !state.jwt) return;
    const projectPath = state.projects.find((project) => project.id === state.activeProjectId)?.path;
    openSessionSocket(state.jwt, projectPath);
    void state.refreshDiff();
  });
}
