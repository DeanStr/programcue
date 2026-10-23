import { CheckCircle2, ShieldCheck, Sparkles } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import {
  type ActionFunctionArgs,
  data,
  Form,
  type LoaderFunctionArgs,
  type MetaFunction,
  type ShouldRevalidateFunctionArgs,
  useActionData,
  useLoaderData,
  useLocation,
  useNavigate,
  useNavigation,
  useRevalidator,
} from "react-router";
import { ZodError } from "zod";
import { adminAssistantDraftFromNavigationState } from "~/components/admin-shell-navigation";
import { Button, ButtonLink } from "~/components/ui/button";
import { PageHeader } from "~/components/ui/page-header";
import { StatusNotice } from "~/components/ui/status-notice";
import type { AiAssistantService } from "~/modules/ai/ai-assistant-service.server";
import { assistantSuggestedPrompts } from "~/modules/ai/ai-assistant-suggestions";
import { WORKERS_AI_MODEL } from "~/modules/ai/ai-provider.server";
import { listAssistantRunReports } from "~/modules/ai/ai-run-report.server";
import {
  AI_ASSISTANT_PROMPT_MAX_LENGTH,
  type AiAssistantResult,
  aiAssistantResultSchema,
} from "~/modules/ai/ai-types";
import {
  AssistantResultPanel,
  ProposalApproval,
} from "~/modules/ai/assistant-result-panel";
import { AssistantRunHistory } from "~/modules/ai/assistant-run-history";
import { getProgramCueEventAgent } from "~/modules/ai/program-cue-agent-client.server";
import { correlationId } from "~/platform/api/api.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import "~/styles/workspace-assistant.css";

export const meta: MetaFunction = () => [
  { title: "Event Assistant · Program Cue" },
];

async function administrator(
  request: Request,
  context: LoaderFunctionArgs["context"],
) {
  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
  ]);
  return { env, viewer };
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const { env, viewer } = await administrator(request, context);
  const agent = await getProgramCueEventAgent(env, viewer);
  const workspace = await agent.getWorkspace(viewer);
  const provider = workspace.provider;
  return {
    eventName: workspace.eventName,
    provider,
    workersAiModel: WORKERS_AI_MODEL,
    canConfigureProvider: workspace.canConfigureProvider,
    proposals: await agent.listRecentProposals(viewer),
    runs: await listAssistantRunReports(env, viewer),
  };
}

// Rejected approvals can retire a preview and failed runs still retain evidence.
// Reload D1 state after POST responses, including validation/conflict responses.
export function shouldRevalidate({
  formMethod,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  return formMethod?.toUpperCase() === "POST" || defaultShouldRevalidate;
}

type ActionResult =
  | {
      ok: true;
      intent: "ask";
      message: string;
      result: Awaited<ReturnType<AiAssistantService["ask"]>>;
      approval: null;
    }
  | {
      ok: true;
      intent: "approve";
      message: string;
      approval: Awaited<ReturnType<AiAssistantService["approveProposal"]>>;
    }
  | {
      ok: true;
      intent: "configure";
      message: string;
      approval: null;
    }
  | {
      ok: true;
      intent: "revise" | "edit_task" | "reject_task";
      message: string;
      approval: null;
    }
  | {
      ok: false;
      intent:
        | "ask"
        | "approve"
        | "revise"
        | "edit_task"
        | "reject_task"
        | "configure"
        | "unknown";
      message: string;
      approval: null;
    };

/**
 * An `AiProviderError` carries the upstream provider's own wording — request
 * ids, quota internals, model names — which is a diagnostic, not copy. What
 * the reader needs instead is whether waiting will help. HTTP status answers
 * that for provider responses, while `failureKind` distinguishes a transport
 * failure from a response that arrived but did not match the contract.
 */
export function providerFailureMessage(error: unknown) {
  const status = (error as { status?: number | null }).status ?? null;
  const failureKind = (error as { failureKind?: unknown }).failureKind;
  if (status === 401 || status === 403)
    return "The AI provider rejected Program Cue's credentials. An organisation owner needs to check the provider settings for this organisation.";
  if (status === 404 || status === 422 || status === 400)
    return "The AI provider rejected the configured model or request. An organisation owner needs to review the provider and model selected for this organisation.";
  if (status === 413)
    return "This request is too large for the configured model. Ask about a smaller part of the event, or select a model with a larger context.";
  if (status === 429)
    return "The AI provider is rate limiting or has no quota left. Wait before trying again, or check the plan on your provider account.";
  if (
    failureKind === "transient" ||
    (status !== null && (status === 408 || status === 425 || status >= 500))
  )
    return "The AI provider is temporarily unavailable. Try again in a moment.";
  return "The AI provider returned a response Program Cue could not read. Report this if it keeps happening.";
}

function knownErrorResponse(
  error: unknown,
  intent:
    | "ask"
    | "approve"
    | "revise"
    | "edit_task"
    | "reject_task"
    | "configure",
) {
  let status: number | null = null;
  const errorName = error instanceof Error ? error.name : "";
  if (
    errorName === "AiConfigurationError" ||
    errorName === "AiAgentRuntimeConfigurationError"
  )
    status = 503;
  if (errorName === "AiProviderError") status = 502;
  if (
    errorName === "AiPermissionError" ||
    errorName === "AiToolPermissionError"
  )
    status = 403;
  if (
    errorName === "AiAssistantBusyError" ||
    errorName === "AiProposalStateError" ||
    errorName === "AiProviderSettingsConflictError" ||
    errorName === "AiContextTooLargeError" ||
    errorName === "CommunicationStateError"
  )
    status = 409;
  if (errorName === "AiProposalNotFoundError") status = 404;
  if (errorName === "CommunicationQueueUnavailableError") status = 503;
  if (errorName === "AiToolValidationError" || error instanceof ZodError)
    status = 422;
  if (status === null) return null;
  const message =
    errorName === "AiProviderError"
      ? providerFailureMessage(error)
      : error instanceof ZodError
        ? (error.issues[0]?.message ?? "Review the assistant request.")
        : error instanceof Error
          ? error.message
          : "The assistant request failed.";
  return data<ActionResult>(
    {
      ok: false,
      intent,
      message,
      approval: null,
    },
    { status },
  );
}

export async function action({ request, context }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { allow: "POST" },
    });
  }
  const { env, viewer } = await administrator(request, context);
  const form = await request.formData();
  const rawIntent = form.get("intent");
  if (
    rawIntent !== "ask" &&
    rawIntent !== "approve" &&
    rawIntent !== "revise" &&
    rawIntent !== "edit_task" &&
    rawIntent !== "reject_task" &&
    rawIntent !== "configure"
  ) {
    return data<ActionResult>(
      {
        ok: false,
        intent: "unknown",
        message: "Unsupported assistant action.",
        approval: null,
      },
      { status: 400 },
    );
  }
  const intent = rawIntent;
  const agent = await getProgramCueEventAgent(env, viewer);
  try {
    if (intent === "configure") {
      const selection = await agent.saveProviderSettings(viewer, {
        provider: form.get("provider"),
        model: form.get("model"),
        revision: form.get("revision"),
      });
      return data<ActionResult>({
        ok: true,
        intent,
        message: `${selection.provider} ${selection.model} is selected for this organisation. Runtime credentials and bindings are checked separately; unavailable configuration will fail explicitly.`,
        approval: null,
      });
    }
    if (intent === "approve") {
      const approval = await agent.approveProposal(
        viewer,
        form.get("proposalId"),
        form.get("confirmed") === "yes",
        correlationId(request),
      );
      return data<ActionResult>({
        ok: true,
        intent,
        message: approval.replayed
          ? approval.kind === "communication"
            ? "This proposal had already been queued; no duplicate communication was created."
            : approval.kind === "task"
              ? "This proposal had already been executed; no duplicate task was created."
              : "This proposal had already been executed; no duplicate domain action was created."
          : approval.kind === "communication"
            ? "The approved reminder was recorded, queued and audited."
            : approval.kind === "task"
              ? "The approved task was created and audited."
              : "The approved domain action was executed and audited.",
        approval,
      });
    }
    if (intent === "edit_task" || intent === "reject_task") {
      await agent.reviewTaskProposal(
        viewer,
        form.get("proposalId"),
        intent === "reject_task"
          ? { decision: "reject", confirmed: form.get("confirmed") === "yes" }
          : {
              decision: "edit",
              title: form.get("title"),
              description: form.get("description"),
              ownerPersonId: form.get("ownerPersonId") || null,
            },
      );
      return data<ActionResult>({
        ok: true,
        intent,
        message:
          intent === "reject_task"
            ? "The task proposal was rejected. No task was created."
            : "The edited task was saved as a new preview. Review it before approval.",
        approval: null,
      });
    }
    if (intent === "revise") {
      await agent.reviseReminderProposal(
        viewer,
        form.get("proposalId"),
        form.get("subject"),
        form.get("body"),
        correlationId(request),
      );
      return data<ActionResult>({
        ok: true,
        intent,
        message:
          "The edited content was saved as a new immutable template version and every recipient was previewed again. Nothing was queued or sent.",
        approval: null,
      });
    }
    const prompt = form.get("suggestedPrompt") ?? form.get("prompt");
    const result = await agent.ask(viewer, prompt);
    return data<ActionResult>({
      ok: true,
      intent,
      message: result.proposals.length
        ? "The assistant prepared a preview. No write has executed."
        : "The assistant completed an evidence-backed advisory response.",
      result,
      approval: null,
    });
  } catch (error) {
    const response = knownErrorResponse(error, intent);
    if (response) return response;
    if (error instanceof Response) throw error;
    throw error;
  }
}

function StreamingAssistantWorkspace({
  draftPrompt,
  setDraftPrompt,
  disabled,
  eventName,
  setResult,
  onRunSettled,
}: {
  draftPrompt: string;
  setDraftPrompt: (prompt: string) => void;
  disabled: boolean;
  eventName: string;
  setResult: (result: AiAssistantResult | null) => void;
  onRunSettled: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [partial, setPartial] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || disabled) return;
    const form = new FormData(event.currentTarget);
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    if (
      submitter instanceof HTMLButtonElement &&
      submitter.name === "suggestedPrompt"
    ) {
      form.set("prompt", submitter.value);
    }
    setPending(true);
    setPartial("");
    setResult(null);
    setError(null);
    try {
      const response = await fetch("/admin/assistant/stream", {
        method: "POST",
        headers: { accept: "text/event-stream" },
        body: form,
      });
      const contentType = response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      if (
        !response.ok ||
        !response.body ||
        contentType !== "text/event-stream"
      ) {
        const failure =
          contentType === "application/json"
            ? ((await response.json().catch(() => null)) as {
                message?: unknown;
              } | null)
            : null;
        throw new Error(
          typeof failure?.message === "string"
            ? failure.message
            : contentType && contentType !== "text/event-stream"
              ? "The assistant streaming endpoint returned an unexpected response. Report this if it keeps happening."
              : "The assistant request could not be completed. Try again.",
        );
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let receivedResultEvent = false;
      let accepted = false;
      const handleBlock = (block: string) => {
        const eventName = block
          .split(/\r?\n/u)
          .find((line) => line.startsWith("event:"))
          ?.slice(6)
          .trim();
        const encoded = block
          .split(/\r?\n/u)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!eventName || !encoded) return;
        const payload = JSON.parse(encoded) as Record<string, unknown>;
        if (eventName === "delta" && typeof payload.delta === "string") {
          setPartial((current) => current + payload.delta);
        } else if (eventName === "result") {
          const result = aiAssistantResultSchema.safeParse(payload);
          if (!result.success) {
            throw new Error(
              "The assistant returned an invalid result. Try again or report this if it keeps happening.",
            );
          }
          receivedResultEvent = true;
          setResult(result.data);
        } else if (
          eventName === "error" &&
          typeof payload.message === "string"
        ) {
          throw new Error(payload.message);
        }
      };
      try {
        while (true) {
          const { value, done } = await reader.read();
          buffer += decoder.decode(value, { stream: !done });
          const blocks = buffer.split(/\r?\n\r?\n/u);
          buffer = blocks.pop() ?? "";
          for (const block of blocks) handleBlock(block);
          if (done) break;
        }
        if (buffer.trim()) handleBlock(buffer);
        if (!receivedResultEvent) {
          throw new Error(
            "The assistant stream ended before Program Cue returned a final result.",
          );
        }
        accepted = true;
      } finally {
        if (!accepted) {
          await reader.cancel("Assistant stream rejected").catch(() => {});
        }
        reader.releaseLock();
      }
    } catch (streamError) {
      setPartial("");
      setResult(null);
      setError(
        streamError instanceof Error
          ? streamError.message
          : "The assistant stream failed.",
      );
    } finally {
      setPending(false);
      await onRunSettled();
    }
  }

  const suggestedPrompts = assistantSuggestedPrompts(eventName).map(
    (prompt) => (
      <button
        className="pc-assist-prompt"
        type="submit"
        form="assistant-stream-form"
        formNoValidate
        name="suggestedPrompt"
        value={prompt.request}
        disabled={pending || disabled}
        key={prompt.label}
      >
        <strong>{prompt.label}</strong>
      </button>
    ),
  );

  return (
    <div className="pc-assist-workspace">
      <section className="pc-assist-compose">
        <h2>What do you need to know or prepare?</h2>
        <div className="stack">
          <form
            action="/admin/assistant"
            method="post"
            className="stack"
            id="assistant-stream-form"
            onSubmit={submit}
          >
            <input type="hidden" name="intent" value="ask" />
            <label className="label">
              Request
              <textarea
                className="textarea"
                name="prompt"
                minLength={2}
                maxLength={AI_ASSISTANT_PROMPT_MAX_LENGTH}
                rows={6}
                required
                value={draftPrompt}
                onChange={(event) => setDraftPrompt(event.currentTarget.value)}
                placeholder="What is blocking event readiness, and what should I address first?"
              />
            </label>
            <p className="help">
              The assistant sees only records returned by event-scoped tools.
            </p>
            <Button
              variant="primary"
              type="submit"
              disabled={disabled}
              pending={pending}
              pendingLabel="Streaming authorised analysis…"
            >
              <Sparkles aria-hidden size={14} />
              Ask assistant
            </Button>
          </form>
          {pending && partial ? (
            <section aria-live="polite" className="pc-assist-stream">
              <h3>Streaming answer</h3>
              <span className="status info">Live</span>
              <div>{partial}</div>
            </section>
          ) : null}
          {error ? (
            <p className="status danger" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </section>

      <aside className="pc-assist-prompts">
        <h2>Useful requests</h2>
        {suggestedPrompts.slice(0, 4)}
        <details className="pc-disclosure">
          <summary>More requests</summary>
          <div className="pc-assist-prompts mt">
            {suggestedPrompts.slice(4)}
          </div>
        </details>
      </aside>
    </div>
  );
}

export default function AssistantRoute() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const location = useLocation();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const navigationDraft = adminAssistantDraftFromNavigationState(
    location.state,
  );
  const [draftPrompt, setDraftPrompt] = useState(() =>
    navigationDraft.status === "ready" ? navigationDraft.prompt : "",
  );
  const [draftNavigationError, setDraftNavigationError] = useState<
    string | null
  >(() =>
    navigationDraft.status === "invalid" ? navigationDraft.message : null,
  );
  const actionResult =
    actionData?.ok && actionData.intent === "ask" ? actionData.result : null;
  const [streamedResult, setStreamedResult] =
    useState<AiAssistantResult | null>(actionResult);
  const busy = navigation.state !== "idle";
  const streamedProposals = streamedResult?.proposals ?? [];
  const streamedProposalIds = new Set(
    streamedProposals.map((proposal) => proposal.id),
  );
  const recentProposals = loaderData.proposals.filter(
    (proposal) => !streamedProposalIds.has(proposal.id),
  );
  const pendingProposals = recentProposals.filter(
    (proposal) =>
      !proposal.executedTaskId &&
      !proposal.executedCommunicationId &&
      !proposal.executedDomainEntityId &&
      !proposal.expired,
  );
  const pastProposals = recentProposals.filter(
    (proposal) => !pendingProposals.includes(proposal),
  );
  const pendingProposalCount =
    streamedProposals.length + pendingProposals.length;

  useEffect(() => {
    const draft = adminAssistantDraftFromNavigationState(location.state);
    if (draft.status === "none") return;
    if (draft.status === "ready") {
      setDraftPrompt(draft.prompt);
      setDraftNavigationError(null);
    } else {
      setDraftPrompt("");
      setDraftNavigationError(draft.message);
    }
    void navigate(
      {
        pathname: location.pathname,
        search: location.search,
        hash: location.hash,
      },
      { replace: true, state: null, preventScrollReset: true },
    );
  }, [
    location.hash,
    location.pathname,
    location.search,
    location.state,
    navigate,
  ]);

  useEffect(() => {
    if (actionData?.ok && actionData.intent === "ask") {
      setStreamedResult(actionData.result);
    } else if (
      actionData &&
      (actionData.intent === "approve" ||
        actionData.intent === "revise" ||
        actionData.intent === "edit_task" ||
        actionData.intent === "reject_task")
    ) {
      setStreamedResult((result) =>
        result ? { ...result, proposals: [] } : null,
      );
    }
  }, [actionData]);
  return (
    <div className="pc-assist">
      <PageHeader
        title="Event Assistant"
        actions={
          <ButtonLink to="/admin/command">Open Command Centre</ButtonLink>
        }
      />

      {!loaderData.provider.configured ? (
        <p className="help" role="status">
          {loaderData.provider.problem} The assistant will not simulate a
          response or fall back to static copy.
        </p>
      ) : null}

      <details className="pc-assist-provider">
        <summary>
          <ShieldCheck aria-hidden size={14} /> Model routing
        </summary>
        {loaderData.canConfigureProvider ? (
          <Form method="post" className="grid grid-3">
            <input type="hidden" name="intent" value="configure" />
            <input
              type="hidden"
              name="revision"
              value={loaderData.provider.selection?.revision ?? 0}
            />
            <label className="label">
              Provider
              <select
                className="select"
                name="provider"
                defaultValue={
                  loaderData.provider.selection?.provider ?? "workers_ai"
                }
                required
              >
                <option value="workers_ai">Workers AI</option>
                <option value="openai">OpenAI / Responses-compatible</option>
                <option value="anthropic">
                  Anthropic / Messages-compatible
                </option>
              </select>
            </label>
            <label className="label">
              Explicit model
              <input
                className="field"
                name="model"
                maxLength={100}
                required
                defaultValue={
                  loaderData.provider.selection?.model ??
                  loaderData.workersAiModel
                }
              />
              <span className="help">
                Workers AI uses {loaderData.workersAiModel}. Enter the exact
                provider model only when selecting OpenAI or Anthropic.
              </span>
            </label>
            <div className="label">
              Apply selection
              <Button
                type="submit"
                pending={busy}
                pendingLabel="Saving provider…"
              >
                Save provider
              </Button>
            </div>
          </Form>
        ) : (
          <>
            {loaderData.provider.selection ? (
              <p className="help">
                Current provider: {loaderData.provider.providerLabel} ·{" "}
                <code>{loaderData.provider.model}</code>
              </p>
            ) : null}
            <p className="help">
              Organisation owners select the provider and model. Event
              administrators can inspect readiness and use the configured
              provider.
            </p>
          </>
        )}
        <p className="help">
          Provider credentials are held in the deployment environment and are
          never shown or entered here. Program Cue never switches to a different
          provider when the selected one is unavailable.
        </p>
      </details>

      {actionData ? (
        <StatusNotice
          title={actionData.message}
          tone={actionData.ok ? "success" : "danger"}
          action={
            actionData.ok && actionData.approval ? (
              <ButtonLink size="small" to={actionData.approval.href}>
                {actionData.approval.kind === "communication"
                  ? "Open operation"
                  : actionData.approval.kind === "task"
                    ? "Open task"
                    : "Open approved result"}
              </ButtonLink>
            ) : undefined
          }
        />
      ) : null}

      {draftNavigationError ? (
        <StatusNotice title={draftNavigationError} tone="danger" />
      ) : null}

      <StreamingAssistantWorkspace
        draftPrompt={draftPrompt}
        setDraftPrompt={setDraftPrompt}
        disabled={busy || !loaderData.provider.configured}
        eventName={loaderData.eventName}
        setResult={setStreamedResult}
        onRunSettled={() => revalidator.revalidate()}
      />

      {streamedResult ? (
        <AssistantResultPanel result={streamedResult} showProposals={false} />
      ) : null}

      <section
        className="pc-assist-recent"
        id="assistant-approvals"
        aria-label="Pending assistant approvals"
      >
        {pendingProposalCount ? (
          <>
            <div className="card-title">
              <h2>Needs your approval</h2>
              <span className="status warning">
                {pendingProposalCount} awaiting approval
              </span>
            </div>
            {streamedProposals.map((proposal) => (
              <ProposalApproval proposal={proposal} key={proposal.id} />
            ))}
            {pendingProposals.map((proposal) => (
              <ProposalApproval proposal={proposal} key={proposal.id} />
            ))}
          </>
        ) : (
          <div className="pc-assist-empty">
            <CheckCircle2 aria-hidden size={18} />
            <h2>No proposals awaiting approval</h2>
          </div>
        )}
      </section>

      <AssistantRunHistory runs={loaderData.runs} />

      {pastProposals.length ? (
        <details
          className="pc-assist-recent"
          open={Boolean(actionData?.ok && actionData.intent === "approve")}
        >
          <summary>Previous action previews ({pastProposals.length})</summary>
          {pastProposals.map((proposal) => (
            <ProposalApproval
              proposal={proposal}
              executedTaskId={proposal.executedTaskId}
              executedCommunicationId={proposal.executedCommunicationId}
              executedOperationId={proposal.executedOperationId}
              executedDomainEntityId={proposal.executedDomainEntityId}
              executedHref={proposal.executedHref}
              expired={proposal.expired}
              key={proposal.id}
            />
          ))}
        </details>
      ) : null}
    </div>
  );
}
