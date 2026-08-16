import {
  createContext,
  type Dispatch,
  type SetStateAction,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useActionData, useNavigation } from "react-router";
import type { ResourceAuthoringService } from "~/modules/resources/resource-authoring-service.server";
import {
  parseResourceDocument,
  type TiptapNode,
  validateResourceDocumentEmbedStructure,
} from "~/modules/resources/resource-content";
import {
  emptyResourceExternalEmbedDraft,
  isResourceRecoveryPayload,
  parseResourceRecoveryPayload,
  type ResourceExternalEmbedDraft,
  type ResourceRecoveryPayload,
} from "~/modules/resources/resource-recovery";
import {
  clearDraftRecoveryScope,
  type DraftRecoveryController,
  useDraftRecovery,
} from "~/platform/drafts/draft-recovery";

type ResourceAdminWorkspaceData = Awaited<
  ReturnType<ResourceAuthoringService["getAdminWorkspace"]>
>;

export type AdminResourcesData = ResourceAdminWorkspaceData & {
  recoveryScope: { eventId: string; personId: string };
  createdFromLocalDraft: boolean;
  liveUpdateDelayed: boolean;
};

type AdminResourcesActionData = {
  ok: boolean;
  message: string;
  intent?: string;
  committed?: boolean;
  conflict?: boolean;
};

type ResourceAudienceScope = NonNullable<
  AdminResourcesData["selected"]
>["audienceScope"];

type ResourceAdminModel = {
  loaderData: AdminResourcesData;
  actionData: AdminResourcesActionData | undefined;
  navigation: ReturnType<typeof useNavigation>;
  pendingIntent: FormDataEntryValue | null | undefined;
  selected: AdminResourcesData["selected"];
  document: TiptapNode;
  setDocument: Dispatch<SetStateAction<TiptapNode>>;
  externalEmbedDraft: ResourceExternalEmbedDraft;
  setExternalEmbedDraft: Dispatch<SetStateAction<ResourceExternalEmbedDraft>>;
  creating: boolean;
  setCreating: Dispatch<SetStateAction<boolean>>;
  audienceScope: ResourceAudienceScope;
  setAudienceScope: Dispatch<SetStateAction<ResourceAudienceScope>>;
  title: string;
  setTitle: Dispatch<SetStateAction<string>>;
  slug: string;
  setSlug: Dispatch<SetStateAction<string>>;
  category: string;
  setCategory: Dispatch<SetStateAction<string>>;
  audiencePersonIds: string[];
  setAudiencePersonIds: Dispatch<SetStateAction<string[]>>;
  acknowledgementRequired: boolean;
  setAcknowledgementRequired: Dispatch<SetStateAction<boolean>>;
  dirty: boolean;
  setDirty: Dispatch<SetStateAction<boolean>>;
  publishConfirmationOpen: boolean;
  setPublishConfirmationOpen: Dispatch<SetStateAction<boolean>>;
  previewViewport: "mobile" | "desktop";
  setPreviewViewport: Dispatch<SetStateAction<"mobile" | "desktop">>;
  recoveryPayload: ResourceRecoveryPayload;
  resourcePreview: { error: string | null };
  restoreDraft(payload: ResourceRecoveryPayload): void;
  editing: AdminResourcesData["selected"];
  editorKey: string;
  recovery: DraftRecoveryController<ResourceRecoveryPayload>;
};

export const emptyResourceDocument: TiptapNode = {
  type: "doc",
  content: [{ type: "paragraph" }],
};

export function useResourceAdminState(
  loaderData: AdminResourcesData,
): ResourceAdminModel {
  const actionData = useActionData<AdminResourcesActionData>();
  const navigation = useNavigation();
  const pendingIntent = navigation.formData?.get("intent");
  const selected = loaderData.selected;
  const [document, setDocument] = useState<TiptapNode>(
    selected?.document ?? emptyResourceDocument,
  );
  const [externalEmbedDraft, setExternalEmbedDraft] = useState(
    emptyResourceExternalEmbedDraft,
  );
  const [creating, setCreating] = useState(!selected);
  const [audienceScope, setAudienceScope] = useState(
    selected?.audienceScope ?? "all_speakers",
  );
  const [title, setTitle] = useState(selected?.title ?? "");
  const [slug, setSlug] = useState(selected?.slug ?? "");
  const [category, setCategory] = useState(selected?.category ?? "");
  const [audiencePersonIds, setAudiencePersonIds] = useState<string[]>(
    selected?.audiencePersonIds ?? [],
  );
  const [acknowledgementRequired, setAcknowledgementRequired] = useState(
    selected?.acknowledgementRequired ?? false,
  );
  const [dirty, setDirty] = useState(false);
  const [publishConfirmationOpen, setPublishConfirmationOpen] = useState(false);
  const [previewViewport, setPreviewViewport] = useState<"mobile" | "desktop">(
    "desktop",
  );
  const recoveryPayload: ResourceRecoveryPayload = useMemo(
    () => ({
      title,
      slug,
      category,
      audienceScope,
      audiencePersonIds,
      acknowledgementRequired,
      document,
      externalEmbedDraft,
    }),
    [
      acknowledgementRequired,
      audiencePersonIds,
      audienceScope,
      category,
      document,
      externalEmbedDraft,
      slug,
      title,
    ],
  );
  const resourcePreview = useMemo(() => {
    try {
      const parsedDocument = parseResourceDocument(document);
      validateResourceDocumentEmbedStructure(parsedDocument);
      return { error: null };
    } catch (error) {
      return {
        error:
          error instanceof Error
            ? error.message
            : "The resource preview could not be rendered.",
      };
    }
  }, [document]);
  const restoreDraft = useCallback((rawPayload: ResourceRecoveryPayload) => {
    const payload = parseResourceRecoveryPayload(rawPayload);
    setTitle(payload.title);
    setSlug(payload.slug);
    setCategory(payload.category);
    setAudienceScope(payload.audienceScope);
    setAudiencePersonIds(payload.audiencePersonIds);
    setAcknowledgementRequired(payload.acknowledgementRequired);
    setDocument(payload.document);
    setExternalEmbedDraft(payload.externalEmbedDraft);
    setDirty(true);
  }, []);
  const editing = creating ? null : selected;
  const editorKey = editing?.versionId ?? "new";
  const recovery = useDraftRecovery({
    scope: {
      ...loaderData.recoveryScope,
      recordType: "resource_page",
      recordId: editing?.id ?? "new",
    },
    serverRevision: `${editing?.revision ?? 0}:${editing?.versionId ?? "new"}`,
    payload: recoveryPayload,
    dirty,
    onRestore: restoreDraft,
    isPayloadCompatible: isResourceRecoveryPayload,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reset only when the selected resource or its authoritative version changes; routine loader object replacement must preserve local edits.
  useEffect(() => {
    setDocument(selected?.document ?? emptyResourceDocument);
    setCreating(!selected);
    setAudienceScope(selected?.audienceScope ?? "all_speakers");
    setTitle(selected?.title ?? "");
    setSlug(selected?.slug ?? "");
    setCategory(selected?.category ?? "");
    setAudiencePersonIds(selected?.audiencePersonIds ?? []);
    setAcknowledgementRequired(selected?.acknowledgementRequired ?? false);
    setExternalEmbedDraft(emptyResourceExternalEmbedDraft);
    setDirty(false);
    setPublishConfirmationOpen(false);
  }, [selected?.id, selected?.versionId]);
  useEffect(() => {
    const committed = Boolean(
      actionData && "committed" in actionData && actionData.committed === true,
    );
    if (
      actionData &&
      (actionData.ok || committed) &&
      "intent" in actionData &&
      (actionData.intent === "save" || actionData.intent === "publish")
    ) {
      setDirty(false);
      void recovery.markServerSaved();
    }
  }, [actionData, recovery.markServerSaved]);
  useEffect(() => {
    if (!loaderData.createdFromLocalDraft) return;
    void clearDraftRecoveryScope({
      ...loaderData.recoveryScope,
      recordType: "resource_page",
      recordId: "new",
    });
  }, [loaderData.createdFromLocalDraft, loaderData.recoveryScope]);
  return {
    loaderData,
    actionData,
    navigation,
    pendingIntent,
    selected,
    document,
    setDocument,
    externalEmbedDraft,
    setExternalEmbedDraft,
    creating,
    setCreating,
    audienceScope,
    setAudienceScope,
    title,
    setTitle,
    slug,
    setSlug,
    category,
    setCategory,
    audiencePersonIds,
    setAudiencePersonIds,
    acknowledgementRequired,
    setAcknowledgementRequired,
    dirty,
    setDirty,
    publishConfirmationOpen,
    setPublishConfirmationOpen,
    previewViewport,
    setPreviewViewport,
    recoveryPayload,
    resourcePreview,
    restoreDraft,
    editing,
    editorKey,
    recovery,
  };
}

export const ResourceAdminModelContext =
  createContext<ResourceAdminModel | null>(null);

export function useResourceAdminModel(): ResourceAdminModel {
  const model = useContext(ResourceAdminModelContext);
  if (!model) throw new Error("Resource administration model is unavailable.");
  return model;
}
