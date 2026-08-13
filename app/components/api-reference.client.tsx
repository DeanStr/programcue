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

export default function ApiReferenceClient() {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = root.current;
    if (!container) return;
    nameScalarCopyButtons(container);
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof Element) nameScalarCopyButtons(node);
        }
      }
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
