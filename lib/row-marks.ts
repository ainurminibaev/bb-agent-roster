// One small role mark on thread rows, drawn by a stylesheet in front of the
// row title (next to the project icon). It never replaces bb's own state glyph
// on the right (running, unread, error, waiting), works for bb's own list and
// for Machine Tabs (both render bb's ThreadRow), and touches no React DOM.
import { isThreadId, KIND_LABEL, type Role, type RoleKind, threadIdsOf } from "../model";

const PATHS: Record<RoleKind, string> = {
  orchestrator: '<path d="M3 7l4.5 4L12 4l4.5 7L21 7l-2 12H5z"/><path d="M5 21h14"/>',
  agent: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4"/><circle cx="12" cy="3" r="1"/><circle cx="9" cy="14" r="1"/><circle cx="15" cy="14" r="1"/>',
  external: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>',
};

function maskUrl(kind: RoleKind): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${PATHS[kind]}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/** A CSS string literal for arbitrary text (each character escaped). */
export function cssString(text: string): string {
  return `"${Array.from(text).map((ch) => `\\${ch.codePointAt(0)!.toString(16)} `).join("")}"`;
}

export const MARK_STYLE_ATTR = "data-agent-roster-marks";

/** The stylesheet for the current roster: one rule per role thread. */
export function markCss(roles: readonly Role[]): string {
  const rules: string[] = [];
  const seen = new Set<string>();
  for (const role of roles) {
    for (const id of threadIdsOf(role)) {
      if (!isThreadId(id) || seen.has(id)) continue;
      seen.add(id);
      const row = `:has(> a[data-sidebar-thread-id="${id}"]) .bb-thread-title::before`;
      const label = cssString(`${KIND_LABEL[role.kind]}: ${role.name}`);
      if (role.icon) {
        rules.push(`${row}{content:${cssString(role.icon)} / ${label};font-size:11px;line-height:1;margin-right:3px;flex-shrink:0}`);
      } else {
        const color = role.kind === "orchestrator" ? "#d97706" : "currentColor";
        const mask = maskUrl(role.kind);
        rules.push(`${row}{content:"" / ${label};display:inline-block;flex-shrink:0;width:11px;height:11px;margin-right:3px;background-color:${color};opacity:.85;-webkit-mask:${mask} center/contain no-repeat;mask:${mask} center/contain no-repeat}`);
      }
    }
  }
  return rules.join("\n");
}

/** Keeps one <style> in sync with the roster; returns the disposer. */
export function mountRowMarks(getRoles: () => readonly Role[] | null, subscribe: (fn: () => void) => () => void): () => void {
  const style = document.createElement("style");
  style.setAttribute(MARK_STYLE_ATTR, "");
  document.head.append(style);
  const paint = () => { style.textContent = markCss(getRoles() ?? []); };
  const unsubscribe = subscribe(paint);
  paint();
  return () => {
    unsubscribe();
    style.remove();
  };
}
