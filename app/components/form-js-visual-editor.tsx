import { useEffect, useState, type ComponentType } from "react";

import type {
  FormJsEditorProps,
  FormJsEditorStatus,
} from "./form-js-editor-contract";

export default function FormJsVisualEditor(props: FormJsEditorProps) {
  const [Editor, setEditor] = useState<ComponentType<FormJsEditorProps> | null>(
    null,
  );

  useEffect(() => {
    let active = true;
    void import("./form-js-editor.client")
      .then((module) => {
        if (active) setEditor(() => module.default);
      })
      .catch((error: unknown) => {
        if (!active) return;
        const detail = error instanceof Error ? error.message : "unknown error";
        props.onStatus({
          state: "error",
          message: `The browser-only form-js editor could not load: ${detail}`,
        });
      });
    return () => {
      active = false;
    };
  }, [props.onStatus]);

  if (!Editor) {
    return (
      <div
        className="form-js-loading"
        role="status"
        aria-label="Visual call-for-speakers form editor"
        aria-describedby={props.ariaDescribedBy}
      >
        Loading the browser-only visual editor…
      </div>
    );
  }
  return <Editor {...props} />;
}

export type { FormJsEditorStatus };
