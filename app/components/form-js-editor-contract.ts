import type { SubmissionFormSchema } from "~/modules/submissions/submission-schema";

export type FormJsEditorStatus =
  | { state: "loading"; message: string }
  | { state: "ready"; message: string }
  | { state: "error"; message: string };

export type FormJsEditorProps = {
  schema: SubmissionFormSchema;
  onChange(schema: SubmissionFormSchema): void;
  onStatus(status: FormJsEditorStatus): void;
  ariaDescribedBy?: string;
};
