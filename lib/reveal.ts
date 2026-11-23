// "Перейти к проекту": scroll the sidebar to the project's section by bb's own
// `data-sidebar-project-id` attribute and flash it briefly with the accent
// colour. No section in the current view → the caller falls back to
// navigate.toProject. No such attribute anywhere (bb changed) → no button.

export function revealSupported(root: ParentNode = document): boolean {
  return root.querySelector("[data-sidebar-project-id]") !== null;
}

function sectionFor(projectId: string, root: ParentNode): HTMLElement | null {
  const sel = `[data-sidebar-project-id="${CSS.escape(projectId)}"]`;
  return root.querySelector<HTMLElement>(`[data-testid="app-sidebar-body"] ${sel}`) ?? root.querySelector<HTMLElement>(sel);
}

/** True when the section was found and revealed. A collapsed section is not forced open. */
export function revealProject(projectId: string, root: ParentNode = document): boolean {
  const section = sectionFor(projectId, root);
  if (!section) return false;
  const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  section.scrollIntoView?.({ block: "start", behavior: reduce ? "auto" : "smooth" });
  const target = section.querySelector<HTMLElement>('[data-sidebar="group-label"]') ?? section;
  target.animate?.(
    [{ backgroundColor: "var(--sidebar-accent, rgba(127,127,127,.18))" }, { backgroundColor: "transparent" }],
    { duration: 1400, easing: "ease-out" },
  );
  return true;
}
