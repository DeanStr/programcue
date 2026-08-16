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

function labelScalarDownloadButtons(root: Element) {
  for (const button of root.querySelectorAll<HTMLButtonElement>(
    "button.download-button",
  )) {
    const extension = button.querySelector<HTMLElement>(".extension");
    if (!extension) {
      throw new Error(
        "Scalar download button is missing its required extension label.",
      );
    }
    const format = extension.textContent?.trim();
    if (!format) {
      throw new Error("Scalar download button has an empty extension label.");
    }
    const formatLabel = format.toUpperCase();
    const visibleLabel = button.querySelector<HTMLElement>(
      "span:not(.extension)",
    );
    if (!visibleLabel) {
      throw new Error(
        "Scalar download button is missing its required visible label.",
      );
    }
    button.setAttribute(
      "aria-label",
      `Download OpenAPI document as ${formatLabel}`,
    );
    const visibleText = `Download ${formatLabel}`;
    if (visibleLabel.textContent !== visibleText) {
      visibleLabel.textContent = visibleText;
    }
    extension.setAttribute("aria-hidden", "true");
  }
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
    let reconcileTimer: number | undefined;
    const reconcileScalarMarkup = () => {
      window.clearTimeout(reconcileTimer);
      reconcileTimer = window.setTimeout(() => {
        nameScalarCopyButtons(container);
        labelScalarDownloadButtons(container);
        repairScalarClientTabPanels(container);
      });
    };
    reconcileScalarMarkup();
    const observer = new MutationObserver(() => {
      reconcileScalarMarkup();
    });
    observer.observe(container, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      window.clearTimeout(reconcileTimer);
    };
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
