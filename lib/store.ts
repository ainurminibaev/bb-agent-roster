// Module state shared by the content script (no React) and the React slots of
// this bundle: the sidebar mount point, the latest roster, and dialog requests.
import { useSyncExternalStore } from "react";
import type { ResolvedRole, RoleKind } from "../model";

export type DialogRequest =
  | { mode: "add"; kind: RoleKind; threadId: string | null; projectId: string | null }
  | { mode: "edit"; roleId: string };

interface State {
  host: HTMLElement | null;
  roles: ResolvedRole[] | null;
  launchDocUrl: string | null;
  dialog: DialogRequest | null;
}

let state: State = { host: null, roles: null, launchDocUrl: null, dialog: null };
const listeners = new Set<() => void>();

export function getState(): State {
  return state;
}
export function setState(patch: Partial<State>): void {
  state = { ...state, ...patch };
  for (const listener of [...listeners]) listener();
}
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function useStore<T>(select: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => select(state), () => select(state));
}
export function openDialog(request: DialogRequest): void {
  setState({ dialog: request });
}
export function resetStore(): void {
  state = { host: null, roles: null, launchDocUrl: null, dialog: null };
  for (const listener of [...listeners]) listener();
}
