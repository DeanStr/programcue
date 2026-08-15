import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type BaseSyntheticEvent,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  useForm,
  useWatch,
  type FieldErrors,
  type Resolver,
} from "react-hook-form";
import { useNavigation, useSubmit } from "react-router";

import {
  saveFormSchema,
  type FormField,
  type SaveFormInput,
} from "~/modules/submissions/submission-schema";
import {
  clearDraftRecoveryScope,
  type DraftRecoveryController,
  useDraftRecovery,
} from "~/platform/drafts/draft-recovery";

export type FormBuilderActionResult = {
  ok: boolean;
  message: string;
  errors?: Record<string, string[]>;
  conflict?: boolean;
};

type ControllerInput = {
  input: SaveFormInput;
  recoveryScope: { eventId: string; personId: string };
  createdFromLocalDraft: boolean;
};

type RecoveryPayload = Omit<SaveFormInput, "accessPassword">;

export type FormBuilderController = {
  categoryField: FormField | undefined;
  change(next: SaveFormInput): void;
  clientValidationLocation: "canvas" | "structure" | null;
  clientValidationMessage: string | null;
  dirty: boolean;
  formRef: RefObject<HTMLFormElement | null>;
  input: SaveFormInput;
  navigationState: "idle" | "loading" | "submitting";
  patchField(patch: Partial<FormField>): void;
  pendingIntent: FormDataEntryValue | null | undefined;
  publishOpen: boolean;
  recovery: DraftRecoveryController<RecoveryPayload>;
  recoveryPayload: RecoveryPayload;
  reportClientValidation(
    message: string,
    location?: "canvas" | "structure",
  ): void;
  selected: FormField | undefined;
  setPublishOpen: Dispatch<SetStateAction<boolean>>;
  setSelectedId: Dispatch<SetStateAction<string>>;
  submitBuilder(event?: BaseSyntheticEvent): Promise<void>;
};

const formBuilderResolver: Resolver<SaveFormInput> = async (values) => {
  const parsed = saveFormSchema.safeParse(values);
  if (parsed.success) return { values: parsed.data, errors: {} };

  const errors: FieldErrors<SaveFormInput> = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (typeof field !== "string" || field in errors) continue;
    Object.assign(errors, {
      [field]: { type: "zod", message: issue.message },
    });
  }
  return { values: {}, errors };
};

export function useFormBuilderController(
  loaderData: ControllerInput,
  actionData: FormBuilderActionResult | undefined,
): FormBuilderController {
  const formRef = useRef<HTMLFormElement>(null);
  const navigation = useNavigation();
  const submit = useSubmit();
  const {
    control,
    getValues,
    handleSubmit,
    reset,
    setValue,
    formState: { isDirty: dirty },
  } = useForm<SaveFormInput>({
    defaultValues: loaderData.input,
    resolver: formBuilderResolver,
    mode: "onChange",
  });
  const input = useWatch({
    control,
    defaultValue: loaderData.input,
  }) as SaveFormInput;
  const [selectedId, setSelectedId] = useState(
    loaderData.input.schema.fields[0]?.id ?? "",
  );
  const [publishOpen, setPublishOpen] = useState(false);
  const [clientValidationMessage, setClientValidationMessage] = useState<
    string | null
  >(null);
  const [clientValidationLocation, setClientValidationLocation] = useState<
    "canvas" | "structure" | null
  >(null);
  const recoveryPayload = useMemo(() => {
    const { accessPassword: _sensitivePassword, ...recoverable } = input;
    return recoverable;
  }, [input]);
  const restoreDraft = useCallback(
    (recoverable: typeof recoveryPayload) => {
      const restored = { ...recoverable, accessPassword: "" } as SaveFormInput;
      reset(restored, { keepDefaultValues: true });
      setSelectedId(restored.schema.fields[0]?.id ?? "");
    },
    [reset],
  );
  const recovery = useDraftRecovery({
    scope: {
      ...loaderData.recoveryScope,
      recordType: "submission_form",
      recordId: input.id ?? "new",
    },
    serverRevision: `${input.revision ?? 0}:${input.draftRevision ?? 0}`,
    payload: recoveryPayload,
    dirty,
    onRestore: restoreDraft,
  });
  const selected =
    input.schema.fields.find((field) => field.id === selectedId) ??
    input.schema.fields[0];
  const categoryField = input.schema.fields.find(
    (field) => field.id === "category",
  );

  useEffect(() => {
    reset(loaderData.input);
    setSelectedId(loaderData.input.schema.fields[0]?.id ?? "");
    setClientValidationMessage(null);
    setClientValidationLocation(null);
  }, [loaderData.input, reset]);
  useEffect(() => {
    if (actionData?.ok) {
      reset(getValues());
      setPublishOpen(false);
      setClientValidationMessage(null);
      setClientValidationLocation(null);
      void recovery.markServerSaved();
    }
  }, [actionData, getValues, recovery.markServerSaved, reset]);
  useEffect(() => {
    if (!loaderData.createdFromLocalDraft) return;
    void clearDraftRecoveryScope({
      ...loaderData.recoveryScope,
      recordType: "submission_form",
      recordId: "new",
    });
  }, [loaderData.createdFromLocalDraft, loaderData.recoveryScope]);

  const pendingIntent = navigation.formData?.get("_intent");
  function change(next: SaveFormInput) {
    const options = { shouldDirty: true, shouldValidate: false } as const;
    if (next.id !== input.id) setValue("id", next.id, options);
    if (next.revision !== input.revision)
      setValue("revision", next.revision, options);
    if (next.draftRevision !== input.draftRevision)
      setValue("draftRevision", next.draftRevision, options);
    if (next.name !== input.name) setValue("name", next.name, options);
    if (next.kind !== input.kind) setValue("kind", next.kind, options);
    if (next.publicSlug !== input.publicSlug)
      setValue("publicSlug", next.publicSlug, options);
    if (next.closeDate !== input.closeDate)
      setValue("closeDate", next.closeDate, options);
    if (next.submissionLimit !== input.submissionLimit)
      setValue("submissionLimit", next.submissionLimit, options);
    if (next.minSpeakers !== input.minSpeakers)
      setValue("minSpeakers", next.minSpeakers, options);
    if (next.maxSpeakers !== input.maxSpeakers)
      setValue("maxSpeakers", next.maxSpeakers, options);
    if (next.accessMode !== input.accessMode)
      setValue("accessMode", next.accessMode, options);
    if (next.accessPassword !== input.accessPassword)
      setValue("accessPassword", next.accessPassword, options);
    if (next.schema !== input.schema) setValue("schema", next.schema, options);
    if (next.routing !== input.routing)
      setValue("routing", next.routing, options);
    setClientValidationMessage(null);
    setClientValidationLocation(null);
  }

  function reportClientValidation(
    message: string,
    location: "canvas" | "structure" | null = null,
  ) {
    setClientValidationMessage(message);
    setClientValidationLocation(location);
  }

  const submitBuilder = handleSubmit(
    (_values, event) => {
      const form = formRef.current;
      if (!form) {
        reportClientValidation("The form submission target is unavailable.");
        return;
      }
      const formData = new FormData(form);
      const submitter = (event?.nativeEvent as SubmitEvent | undefined)
        ?.submitter;
      if (
        submitter instanceof HTMLButtonElement &&
        submitter.name &&
        submitter.value
      ) {
        formData.set(submitter.name, submitter.value);
      }
      submit(formData, { method: "post" });
    },
    () => {
      const parsed = saveFormSchema.safeParse(input);
      reportClientValidation(
        parsed.success
          ? "Review the form settings before continuing."
          : (parsed.error.issues[0]?.message ??
              "Review the form settings before continuing."),
      );
    },
  );

  function patchField(patch: Partial<FormField>) {
    if (!selected) return;
    change({
      ...input,
      schema: {
        ...input.schema,
        fields: input.schema.fields.map((field) =>
          field.id === selected.id ? { ...field, ...patch } : field,
        ),
      },
    });
  }

  return {
    categoryField,
    change,
    clientValidationLocation,
    clientValidationMessage,
    dirty,
    formRef,
    input,
    navigationState: navigation.state,
    patchField,
    pendingIntent,
    publishOpen,
    recovery,
    recoveryPayload,
    reportClientValidation,
    selected,
    setPublishOpen,
    setSelectedId,
    submitBuilder,
  };
}
