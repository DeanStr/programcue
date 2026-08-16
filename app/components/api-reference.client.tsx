import { ApiReferenceReact } from "@scalar/api-reference-react";
import "@scalar/api-reference-react/style.css";
import { useEffect, useRef } from "react";

function nameScalarCopyButtons(root: Element) {
  const buttons = root.matches("button.scalar-code-copy")
    ? [root as HTMLButtonElement]
    : root.querySelectorAll<HTMLButtonElement>("button.scalar-code-copy");
  buttons.forEach((button) => {
    if (!button.hasAttribute("aria-label")) {
      button.setAttribute("aria-label", "Copy code");
    }
  });
}

/* Scalar currently reuses each client tab-panel ID for its nested disclosure
   panel. Keep this workaround exact so any different malformed markup still
   fails the real-page duplicate-ID assertion. */
function repairScalarClientTabPanels(container: Element) {
  const tabs = Array.from(
    container.querySelectorAll<HTMLElement>('[role="tab"][aria-controls]'),
  );
  for (const disclosure of container.querySelectorAll<HTMLElement>("div[id]")) {
    if (
      !disclosure.classList.contains("group/collapse") ||
      !disclosure.classList.contains("group/params")
    ) {
      continue;
    }
    const duplicatePanel = Array.from(
      disclosure.querySelectorAll<HTMLElement>(".diclosure-panel[id]"),
    ).find((panel) => panel.id === disclosure.id);
    const tab = tabs.find(
      (candidate) => candidate.getAttribute("aria-controls") === disclosure.id,
    );
    if (!duplicatePanel || !tab) continue;
    const tabPanelId = `${disclosure.id}--tab-panel`;
    if (document.getElementById(tabPanelId)) continue;
    disclosure.id = tabPanelId;
    tab.setAttribute("aria-controls", tabPanelId);
  }
}

export default function ApiReferenceClient() {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = root.current;
    if (!container) return;
    nameScalarCopyButtons(container);
    repairScalarClientTabPanels(container);
    const observer = new MutationObserver((mutations) => {
      let scalarClientChanged = false;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof Element) {
            scalarClientChanged = true;
            nameScalarCopyButtons(node);
          }
        }
      }
      if (scalarClientChanged) repairScalarClientTabPanels(container);
    });
    observer.observe(container, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={root} className="program-cue-api-reference">
      <ApiReferenceReact
        configuration={{
          url: "/openapi.json",
          layout: "modern",
          showOperationId: true,
          documentDownloadType: "both",
          hideTestRequestButton: false,
          hideClientButton: false,
          hideModels: false,
          hideDarkModeToggle: false,
          darkMode: false,
          withDefaultFonts: false,
          agent: { disabled: true },
          metaData: { title: "Program Cue API Reference" },
        }}
      />
    </div>
  );
}
