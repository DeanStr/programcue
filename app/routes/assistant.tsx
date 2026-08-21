import { CheckCircle2, ShieldCheck, Sparkles } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import {
  type ActionFunctionArgs,
  data,
  Form,
  Link,
  type LoaderFunctionArgs,
  type MetaFunction,
  useActionData,
  useLoaderData,
  useNavigation,
  useRevalidator,
} from "react-router";
import { ZodError } from "zod";
import { PageHeader } from "~/components/ui/page-header";
import { StatusNotice } from "~/components/ui/status-notice";
import type { AiAssistantService } from "~/modules/ai/ai-assistant-service.server";
import { WORKERS_AI_MODEL } from "~/modules/ai/ai-provider.server";
import type { AiAssistantResult } from "~/modules/ai/ai-types";
import {
  AssistantResultPanel,
  ProposalApproval,
} from "~/modules/ai/assistant-result-panel";
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
    prompt:
      new URL(request.url).searchParams.get("prompt")?.slice(0, 4_000) ?? "",
    proposals: await agent.listRecentProposals(viewer),
  };
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
      intent: "revise";
      message: string;
      approval: null;
    }
  | {
      ok: false;
      intent: "ask" | "approve" | "revise" | "configure" | "unknown";
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
  intent: "ask" | "approve" | "revise" | "configure",
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
  defaultPrompt,
  disabled,
  eventName,
  result,
  setResult,
  onAcceptedResult,
}: {
  defaultPrompt: string;
  disabled: boolean;
  eventName: string;
  result: AiAssistantResult | null;
  setResult: (result: AiAssistantResult | null) => void;
  onAcceptedResult: () => Promise<void>;
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
          receivedResultEvent = true;
          setResult(payload as unknown as AiAssistantResult);
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
        await onAcceptedResult();
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
    }
  }

  const suggestedPrompts = [
    "What is blocking event readiness? Cite the exact records and rank the next three actions.",
    "Find speakers with incomplete tasks and draft a reminder. Do not send it.",
    `Propose one event task for ${eventName} that addresses the highest readiness blocker. Save a preview only.`,
    "Explain current schedule conflicts and distinguish recorded facts from your inference.",
    "Inspect the current form configuration and propose a new application form draft. Do not publish it.",
    "Inspect the draft evaluation round and propose an exact rubric update with valid weights. Do not activate or assign it.",
    "Inspect the active evaluation round and propose reviewer assignments for currently unassigned targets. Preview every target and reviewer.",
    "Prepare an editable email template draft for the next speaker briefing. Do not publish or send it.",
    "Inspect the draft schedule and propose one conflict-free placement for an unscheduled session. Do not publish it.",
    "Preview the exact Accelevents export plan as a dry run. Do not contact the provider until I approve.",
  ];

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
                maxLength={4_000}
                rows={6}
                required
                defaultValue={defaultPrompt}
                placeholder="What is blocking event readiness, and what should I address first?"
              />
            </label>
            <p className="help">
              The assistant sees only records returned by event-scoped tools.
              Provider or validation failures are reported explicitly.
            </p>
            <button
              className="btn primary"
              type="submit"
              disabled={pending || disabled}
            >
              <Sparkles aria-hidden size={14} />
              {pending ? "Streaming authorised analysis…" : "Ask assistant"}
            </button>
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
          {result ? (
            <AssistantResultPanel result={result} showProposals={false} />
          ) : null}
        </div>
      </section>

      <aside className="pc-assist-prompts">
        <h2>Useful requests</h2>
        {suggestedPrompts.map((prompt) => (
          <button
            className="pc-assist-prompt"
            type="submit"
            form="assistant-stream-form"
            formNoValidate
            name="suggestedPrompt"
            value={prompt}
            disabled={pending || disabled}
            key={prompt}
          >
            <strong>{prompt}</strong>
          </button>
        ))}
      </aside>
    </div>
  );
}

export default function AssistantRoute() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
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
  const pendingProposalCount =
    streamedProposals.length +
    recentProposals.filter(
      (proposal) =>
        !proposal.executedTaskId &&
        !proposal.executedCommunicationId &&
        !proposal.executedDomainEntityId &&
        !proposal.expired,
    ).length;
  const hasProposalHistory =
    streamedProposals.length > 0 || recentProposals.length > 0;

  useEffect(() => {
    if (actionData?.ok && actionData.intent === "ask") {
      setStreamedResult(actionData.result);
    } else if (
      actionData?.ok &&
      (actionData.intent === "approve" || actionData.intent === "revise")
    ) {
      setStreamedResult(null);
    }
  }, [actionData]);
  return (
    <div className="pc-assist">
      <PageHeader
        eyebrow="Authorised event tools"
        title="Event Assistant"
        description={`Ask about ${loaderData.eventName}, inspect the exact source records and preview safe actions before approval.`}
        actions={
          <Link className="btn" to="/admin/command">
            Open Command Centre
          </Link>
        }
      />

      {!loaderData.provider.configured ? (
        <p className="help" role="status">
          {loaderData.provider.problem} The assistant will not simulate a
          response or fall back to static copy.
        </p>
      ) : (
        <StatusNotice
          title={`${loaderData.provider.providerLabel} ${loaderData.provider.model} is configured`}
        >
          Requests use the selected provider with strict allow-listed tools.
          Reads may run immediately; writes stop at a saved preview until you
          approve the exact effect.
        </StatusNotice>
      )}

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
                className="input"
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
              <button className="btn" type="submit" disabled={busy}>
                Save provider
              </button>
            </div>
          </Form>
        ) : (
          <p className="help">
            Organisation owners select the provider and model. Event
            administrators can inspect readiness and use the configured
            provider.
          </p>
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
              <Link className="btn small" to={actionData.approval.href}>
                {actionData.approval.kind === "communication"
                  ? "Open operation"
                  : actionData.approval.kind === "task"
                    ? "Open task"
                    : "Open approved result"}
              </Link>
            ) : undefined
          }
        />
      ) : null}

      <StreamingAssistantWorkspace
        defaultPrompt={loaderData.prompt}
        disabled={busy || !loaderData.provider.configured}
        eventName={loaderData.eventName}
        result={streamedResult}
        setResult={setStreamedResult}
        onAcceptedResult={() => revalidator.revalidate()}
      />

      {hasProposalHistory ? (
        <section className="pc-assist-recent">
          <div className="card-title">
            <h2>Write previews</h2>
            <span className="status warning">
              {pendingProposalCount} awaiting approval
            </span>
          </div>
          {streamedProposals.map((proposal) => (
            <ProposalApproval proposal={proposal} key={proposal.id} />
          ))}
          {recentProposals.map((proposal) => (
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
        </section>
      ) : (
        <section className="pc-assist-empty">
          <CheckCircle2 aria-hidden size={18} />
          <h2>No pending assistant writes</h2>
          <p className="subtle">
            Read and draft actions do not mutate event records. Any proposed
            task or reminder send will appear here with an exact preview and
            confirmation.
          </p>
        </section>
      )}
    </div>
  );
}
