// Finds the sidebar spot between thread search and the thread list, for both
// bb's own list and the Machine Tabs list. No spot → null: the block is simply
// not drawn and nothing else changes.

/** The sidebar's scroll area that holds the thread list. */
export function findSidebarContent(root: ParentNode = document): HTMLElement | null {
  const main = root.querySelector<HTMLElement>('[data-testid="app-sidebar-body"] [data-sidebar="content"]');
  if (main) return main;
  // Without the test id, still skip the Settings/Plugins/Skills section sidebars.
  return Array.from(root.querySelectorAll<HTMLElement>('[data-sidebar="sidebar"] [data-sidebar="content"]')).find((el) => {
    const body = el.closest<HTMLElement>('[data-testid$="-sidebar-body"]');
    return !body || body.dataset.testid === "nav-rail-sidebar-body";
  }) ?? null;
}

export interface Placement {
  parent: HTMLElement;
  before: Node | null;
  layout: "machine-tabs" | "standard";
}

/**
 * Machine Tabs draws its own search at the top of the list, then "Last N",
 * then the list; the block goes right before the first of its list blocks.
 * bb's own list has no search inside (search lives in the navigation above),
 * so the block goes first in the scroll area.
 */
export function findPlacement(root: ParentNode = document): Placement | null {
  const content = findSidebarContent(root);
  if (!content) return null;
  const firstList = content.querySelector<HTMLElement>("[data-machine-tabs-list]");
  if (firstList?.parentElement) {
    return { parent: firstList.parentElement, before: firstList, layout: "machine-tabs" };
  }
  // Machine Tabs while its list is still loading: right after its search.
  const search = content.querySelector<HTMLElement>(".machine-tabs-search");
  if (search?.parentElement) {
    let before = search.nextSibling;
    while (before instanceof HTMLElement && before.hasAttribute(HOST_ATTR)) before = before.nextSibling;
    return { parent: search.parentElement, before, layout: "machine-tabs" };
  }
  return { parent: content, before: content.firstChild, layout: "standard" };
}

export const HOST_ATTR = "data-agent-roster-block";

/** True when `host` already sits exactly at the placement. */
export function isPlaced(host: HTMLElement, placement: Placement): boolean {
  if (host.parentElement !== placement.parent) return false;
  if (placement.before === host) return true;
  return host.nextSibling === placement.before;
}

/** Keeps `host` at the spot while the sidebar re-renders. */
export function keepPlaced(host: HTMLElement, signal: AbortSignal, onChange: (placed: boolean) => void): () => void {
  let placed = false;
  let scheduled = 0;
  const place = () => {
    scheduled = 0;
    if (signal.aborted) return;
    const placement = findPlacement();
    if (!placement) {
      if (host.isConnected) host.remove();
      if (placed) { placed = false; onChange(false); }
      return;
    }
    host.dataset.layout = placement.layout;
    if (!isPlaced(host, placement)) {
      try {
        placement.parent.insertBefore(host, placement.before === host ? host.nextSibling : placement.before);
      } catch {
        host.remove();
      }
    }
    if (!placed && host.isConnected) { placed = true; onChange(true); }
  };
  const observer = new MutationObserver(() => {
    if (!scheduled) scheduled = window.requestAnimationFrame(place);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  place();
  return () => {
    observer.disconnect();
    if (scheduled) window.cancelAnimationFrame(scheduled);
    host.remove();
  };
}
