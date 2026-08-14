import { useEffect, useRef } from "react";
import {
  Checklist,
  FormEditor,
  Select,
  Textfield,
  type FormEditor as FormEditorInstance,
} from "@bpmn-io/form-js";
import "@bpmn-io/form-js/dist/assets/form-js.css";
import "@bpmn-io/form-js/dist/assets/form-js-editor.css";

import type { FormJsEditorProps } from "./form-js-editor-contract";
import {
  FormJsAdapterError,
  fromFormJsSchema,
  PROGRAM_CUE_FORM_JS_TYPES,
  toFormJsSchema,
} from "~/modules/submissions/form-js-adapter";
import {
  createFormJsImportQueue,
  type FormJsImportQueue,
} from "./form-js-import-queue";

type FormFieldRenderer = ((props: unknown) => unknown) & {
  config: Record<string, unknown>;
};

type FormFieldsRegistry = {
  register(type: string, renderer: FormFieldRenderer): void;
};

function extendField(
  base: FormFieldRenderer,
  type: string,
  name: string,
  propertiesPanelEntries: string[],
) {
  const renderer = ((props: unknown) => base(props)) as FormFieldRenderer;
  renderer.config = {
    ...base.config,
    type,
    name,
    label: name,
    propertiesPanelEntries,
    create: (options: Record<string, unknown> = {}) => ({
      ...((
        base.config.create as
          | ((options?: Record<string, unknown>) => Record<string, unknown>)
          | undefined
      )?.(options) ?? options),
      ...options,
    }),
  };
  return renderer;
}

function normalizeChoiceField(
  base: FormFieldRenderer,
  type: "select" | "checklist",
  name: string,
) {
  const renderer = ((props: unknown) => base(props)) as FormFieldRenderer;
  renderer.config = {
    ...base.config,
    type,
    name,
    label: name,
    create: (options: Record<string, unknown> = {}) => {
      const normalizedOptions =
        options.values === undefined &&
        options.valuesKey === undefined &&
        options.valuesExpression === undefined
          ? {
              ...options,
              values: [{ label: "Option", value: "Option" }],
            }
          : options;
      return (
        (
          base.config.create as
            | ((options?: Record<string, unknown>) => Record<string, unknown>)
            | undefined
        )?.(normalizedOptions) ?? normalizedOptions
      );
    },
  };
  return renderer;
}

const keyedEntries = ["key", "label", "description", "required"];
const choiceEntries = [...keyedEntries, "values"];

const conferenceFields: Array<[string, FormFieldRenderer]> = [
  [
    "select",
    normalizeChoiceField(
      Select as unknown as FormFieldRenderer,
      "select",
      "Single choice",
    ),
  ],
  [
    "checklist",
    normalizeChoiceField(
      Checklist as unknown as FormFieldRenderer,
      "checklist",
      "Multiple choice",
    ),
  ],
  [
    PROGRAM_CUE_FORM_JS_TYPES.title,
    extendField(
      Textfield as unknown as FormFieldRenderer,
      PROGRAM_CUE_FORM_JS_TYPES.title,
      "Session title (Program Cue)",
      keyedEntries,
    ),
  ],
  [
    PROGRAM_CUE_FORM_JS_TYPES.category,
    extendField(
      Checklist as unknown as FormFieldRenderer,
      PROGRAM_CUE_FORM_JS_TYPES.category,
      "Session tracks (Program Cue)",
      choiceEntries,
    ),
  ],
  [
    PROGRAM_CUE_FORM_JS_TYPES.format,
    extendField(
      Select as unknown as FormFieldRenderer,
      PROGRAM_CUE_FORM_JS_TYPES.format,
      "Session format (Program Cue)",
      choiceEntries,
    ),
  ],
  [
    PROGRAM_CUE_FORM_JS_TYPES.url,
    extendField(
      Textfield as unknown as FormFieldRenderer,
      PROGRAM_CUE_FORM_JS_TYPES.url,
      "Conference URL",
      keyedEntries,
    ),
  ],
  [
    PROGRAM_CUE_FORM_JS_TYPES.video,
    extendField(
      Textfield as unknown as FormFieldRenderer,
      PROGRAM_CUE_FORM_JS_TYPES.video,
      "Conference video",
      keyedEntries,
    ),
  ],
];

class ProgramCueConferenceFields {
  static $inject = ["formFields"];

  constructor(formFields: FormFieldsRegistry) {
    for (const [type, renderer] of conferenceFields) {
      formFields.register(type, renderer);
    }
  }
}

const programCueConferenceFieldsModule = {
  __init__: ["programCueConferenceFields"],
  programCueConferenceFields: ["type", ProgramCueConferenceFields],
};

function errorMessage(error: unknown) {
  if (error instanceof FormJsAdapterError || error instanceof Error) {
    return error.message;
  }
  return "The visual form editor failed with an unknown error.";
}

function labelFormJsControls(container: HTMLElement) {
  const paletteSearch = container.querySelector<HTMLInputElement>(
    ".fjs-palette-search",
  );
  if (
    paletteSearch &&
    !paletteSearch.labels?.length &&
    !paletteSearch.hasAttribute("aria-label") &&
    !paletteSearch.hasAttribute("aria-labelledby")
  ) {
    paletteSearch.setAttribute("aria-label", "Search form components");
  }
}

export default function FormJsEditorClient({
  schema,
  onChange,
  onStatus,
  ariaDescribedBy,
}: FormJsEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<FormEditorInstance | null>(null);
  const importQueueRef = useRef<FormJsImportQueue | null>(null);
  const importingRef = useRef(false);
  const lastEmittedFingerprintRef = useRef<string | null>(null);
  const lastRequestedFingerprintRef = useRef<string | null>(null);
  const schemaRef = useRef(schema);
  const onChangeRef = useRef(onChange);
  const onStatusRef = useRef(onStatus);

  schemaRef.current = schema;
  onChangeRef.current = onChange;
  onStatusRef.current = onStatus;

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    let disposed = false;
    const editor = new FormEditor({
      container,
      additionalModules: [programCueConferenceFieldsModule],
      // Program Cue's normalized RHF value is the save source of truth. Do not
      // leave a visually edited form-js property pending when save is invoked.
      debounce: false,
      exporter: { name: "Program Cue form adapter", version: "1" },
    });
    editorRef.current = editor;
    const accessibilityObserver = new MutationObserver(() =>
      labelFormJsControls(container),
    );
    accessibilityObserver.observe(container, {
      childList: true,
      subtree: true,
    });
    labelFormJsControls(container);
    const importQueue = createFormJsImportQueue();
    importQueueRef.current = importQueue;

    const handleChanged = () => {
      if (disposed || importingRef.current) return;
      try {
        const next = fromFormJsSchema(
          editor.saveSchema(),
          schemaRef.current.presentation,
        );
        lastEmittedFingerprintRef.current = JSON.stringify(next);
        onChangeRef.current(next);
        onStatusRef.current({
          state: "ready",
          message: "Visual form changes are mapped to the Program Cue draft.",
        });
      } catch (error) {
        onStatusRef.current({ state: "error", message: errorMessage(error) });
      }
    };
    editor.on("changed", handleChanged);

    const initialSchema = schemaRef.current;
    const initialFingerprint = JSON.stringify(initialSchema);
    lastRequestedFingerprintRef.current = initialFingerprint;
    importQueue.enqueue({
      fingerprint: initialFingerprint,
      run: async () => {
        importingRef.current = true;
        try {
          const result = await editor.importSchema(
            toFormJsSchema(initialSchema),
          );
          if (result.warnings.length) {
            throw new FormJsAdapterError(
              `form-js reported ${result.warnings.length} import warning${result.warnings.length === 1 ? "" : "s"}.`,
            );
          }
          if (
            !disposed &&
            lastRequestedFingerprintRef.current === initialFingerprint
          ) {
            onStatusRef.current({
              state: "ready",
              message: "Visual editor ready.",
            });
          }
        } catch (error) {
          if (
            !disposed &&
            lastRequestedFingerprintRef.current === initialFingerprint
          ) {
            onStatusRef.current({
              state: "error",
              message: errorMessage(error),
            });
          }
        } finally {
          importingRef.current = false;
        }
      },
    });

    return () => {
      disposed = true;
      accessibilityObserver.disconnect();
      importQueue.dispose();
      editor.off("changed", handleChanged);
      editor.destroy();
      editorRef.current = null;
      importQueueRef.current = null;
    };
  }, []);

  const schemaFingerprint = JSON.stringify(schema);
  useEffect(() => {
    const editor = editorRef.current;
    const importQueue = importQueueRef.current;
    if (!editor || !importQueue) return;
    if (lastEmittedFingerprintRef.current === schemaFingerprint) {
      lastEmittedFingerprintRef.current = null;
      lastRequestedFingerprintRef.current = schemaFingerprint;
      return;
    }
    if (lastRequestedFingerprintRef.current === schemaFingerprint) {
      return;
    }

    let active = true;
    lastRequestedFingerprintRef.current = schemaFingerprint;
    importQueue.enqueue({
      fingerprint: schemaFingerprint,
      run: async () => {
        importingRef.current = true;
        try {
          const result = await editor.importSchema(toFormJsSchema(schema));
          if (result.warnings.length) {
            throw new FormJsAdapterError(
              `form-js reported ${result.warnings.length} import warning${result.warnings.length === 1 ? "" : "s"}.`,
            );
          }
          if (
            active &&
            lastRequestedFingerprintRef.current === schemaFingerprint
          ) {
            onStatusRef.current({
              state: "ready",
              message: "Visual form and Program Cue draft are synchronized.",
            });
          }
        } catch (error) {
          if (
            active &&
            lastRequestedFingerprintRef.current === schemaFingerprint
          ) {
            onStatusRef.current({
              state: "error",
              message: errorMessage(error),
            });
          }
        } finally {
          importingRef.current = false;
        }
      },
    });
    return () => {
      active = false;
    };
  }, [schema, schemaFingerprint]);

  return (
    <div
      className="program-cue-form-js"
      ref={containerRef}
      role="region"
      aria-label="Visual call-for-speakers form editor"
      aria-describedby={ariaDescribedBy}
    />
  );
}
