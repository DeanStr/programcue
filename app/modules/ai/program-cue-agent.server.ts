import { Agent } from "agents";
import type { Viewer } from "~/platform/auth/authorize.server";
import { AiAssistantService } from "./ai-assistant-service.server";
import { AiProviderSettingsService } from "./ai-provider.server";

export type ProgramCueAgentState = {
  version: 1;
  scopeFingerprint: string | null;
  lastRunId: string | null;
  pendingProposalIds: string[];
  lastAction: {
    proposalId: string;
    entityId: string;
    status: "executed";
    updatedAt: number;
  } | null;
};

async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function viewerScopeFingerprint(viewer: Viewer) {
  return sha256(
    `${viewer.organisationId}:${viewer.eventId}:${viewer.personId}`,
  );
}

/**
 * One private Durable Object per signed-in administrator and event. D1 remains
 * authoritative for proposals, approvals and audit; Agent state is deliberately
 * limited to non-content coordination identifiers for resumable UI sessions.
 */
export class ProgramCueEventAgent extends Agent<
  Cloudflare.Env,
  ProgramCueAgentState
> {
  initialState: ProgramCueAgentState = {
    version: 1,
    scopeFingerprint: null,
    lastRunId: null,
    pendingProposalIds: [],
    lastAction: null,
  };

  private async assertScope(viewer: Viewer) {
    const scopeFingerprint = await viewerScopeFingerprint(viewer);
    if (
      this.state.scopeFingerprint &&
      this.state.scopeFingerprint !== scopeFingerprint
    ) {
      throw new Error(
        "This event assistant instance is already bound to a different authorised scope.",
      );
    }
    if (!this.state.scopeFingerprint) {
      this.setState({ ...this.state, scopeFingerprint });
    }
  }

  private recordAssistantResult(
    result: Awaited<ReturnType<AiAssistantService["ask"]>>,
  ) {
    const pendingProposalIds = [
      ...new Set([
        ...this.state.pendingProposalIds,
        ...result.proposals.map((proposal) => proposal.id),
      ]),
    ].slice(-20);
    this.setState({
      ...this.state,
      lastRunId: result.runId,
      pendingProposalIds,
    });
  }

  async getWorkspace(viewer: Viewer) {
    await this.assertScope(viewer);
    return new AiAssistantService(
      this.env as unknown as CloudflareEnvironment,
    ).getWorkspace(viewer);
  }

  async listRecentProposals(viewer: Viewer) {
    await this.assertScope(viewer);
    return new AiAssistantService(
      this.env as unknown as CloudflareEnvironment,
    ).listRecentProposals(viewer);
  }

  async saveProviderSettings(viewer: Viewer, input: unknown) {
    await this.assertScope(viewer);
    return new AiProviderSettingsService(
      this.env as unknown as CloudflareEnvironment,
    ).save(viewer, input);
  }

  async ask(viewer: Viewer, prompt: unknown) {
    await this.assertScope(viewer);
    const result = await new AiAssistantService(
      this.env as unknown as CloudflareEnvironment,
    ).ask(viewer, prompt);
    this.recordAssistantResult(result);
    return result;
  }

  async streamAsk(viewer: Viewer, prompt: unknown) {
    await this.assertScope(viewer);
    const { readable, writable } = new TransformStream<
      Uint8Array,
      Uint8Array
    >();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    let open = true;
    let pendingWrite = Promise.resolve();
    const send = (event: string, value: unknown) => {
      pendingWrite = pendingWrite
        .then(async () => {
          if (!open) return;
          await writer.write(
            encoder.encode(
              `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`,
            ),
          );
        })
        .catch(() => {
          open = false;
        });
    };
    const execution = (async () => {
      send("status", {
        phase: "inspecting",
        message: "Inspecting authorised event records…",
      });
      try {
        const result = await new AiAssistantService(
          this.env as unknown as CloudflareEnvironment,
        ).ask(viewer, prompt, (delta) => send("delta", { delta }));
        this.recordAssistantResult(result);
        send("result", result);
      } catch (error) {
        const known = new Set([
          "AiConfigurationError",
          "AiContextTooLargeError",
          "AiPermissionError",
          "AiProviderError",
          "AiToolPermissionError",
          "AiToolValidationError",
          "ZodError",
        ]);
        send("error", {
          message:
            error instanceof Error && known.has(error.name)
              ? error.message
              : "The assistant stream failed before producing a result.",
        });
      } finally {
        await pendingWrite;
        if (open) await writer.close();
      }
    })();
    this.ctx.waitUntil(execution);
    return readable;
  }

  async approveProposal(
    viewer: Viewer,
    proposalId: unknown,
    confirmed: boolean,
    correlationId: string,
  ) {
    await this.assertScope(viewer);
    const result = await new AiAssistantService(
      this.env as unknown as CloudflareEnvironment,
    ).approveProposal(viewer, proposalId, confirmed, correlationId);
    this.setState({
      ...this.state,
      pendingProposalIds: this.state.pendingProposalIds.filter(
        (candidate) => candidate !== result.proposalId,
      ),
      lastAction: {
        proposalId: result.proposalId,
        entityId:
          result.kind === "task"
            ? result.taskId
            : result.kind === "communication"
              ? result.communicationId
              : result.entityId,
        status: "executed",
        updatedAt: Math.floor(Date.now() / 1_000),
      },
    });
    return result;
  }

  async reviseReminderProposal(
    viewer: Viewer,
    proposalId: unknown,
    subject: unknown,
    body: unknown,
    correlationId: string,
  ) {
    await this.assertScope(viewer);
    const result = await new AiAssistantService(
      this.env as unknown as CloudflareEnvironment,
    ).reviseReminderProposal(viewer, proposalId, subject, body, correlationId);
    this.setState({
      ...this.state,
      pendingProposalIds: [
        ...this.state.pendingProposalIds.filter(
          (candidate) => candidate !== proposalId,
        ),
        result.id,
      ].slice(-20),
    });
    return result;
  }
}

export async function programCueAgentInstanceName(viewer: Viewer) {
  return `event-${await viewerScopeFingerprint(viewer)}`;
}
