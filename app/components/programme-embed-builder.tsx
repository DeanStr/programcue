import { useRef } from "react";
import type { ManagedProgrammeEmbed } from "~/modules/programme/programme-embed-service.server";
import { EmbedConfigurationWorkflow } from "./programme-embed-configuration-panel";
import { ManagedEmbedWorkflow } from "./programme-embed-managed-panel";
import {
  type ProgrammeEmbedSession,
  useProgrammeEmbedBuilder,
} from "./use-programme-embed-builder";

export function ProgrammeEmbedBuilder({
  publicOrigin,
  publicSlug,
  eventName,
  eventAccent,
  timezone,
  sessions,
  managedEmbeds,
  activePanel,
  onOpenBuilder,
}: {
  publicOrigin: string;
  publicSlug: string;
  eventName: string;
  eventAccent: string;
  timezone: string;
  sessions: ProgrammeEmbedSession[];
  managedEmbeds: ManagedProgrammeEmbed[];
  activePanel: "builder" | "managed";
  onOpenBuilder(): void;
}) {
  const builderHeadingRef = useRef<HTMLHeadingElement>(null);
  const { configurationWorkflow, managedWorkflow } = useProgrammeEmbedBuilder({
    publicOrigin,
    publicSlug,
    eventName,
    timezone,
    sessions,
    managedEmbeds,
  });
  function openBuilderFromManagedEmbed() {
    onOpenBuilder();
    window.requestAnimationFrame(() => {
      builderHeadingRef.current?.focus();
      builderHeadingRef.current?.scrollIntoView({ block: "start" });
    });
  }
  return (
    <div className="programme-embed-builder">
      <section
        aria-labelledby="programme-embed-title"
        hidden={activePanel !== "builder"}
      >
        <div className="programme-panel-heading">
          <h2 id="programme-embed-title" ref={builderHeadingRef} tabIndex={-1}>
            Embed builder
          </h2>
          <p className="help">
            Configure, preview and copy a stateless published-programme embed.
          </p>
        </div>
        <EmbedConfigurationWorkflow
          workflow={configurationWorkflow}
          eventAccent={eventAccent}
        />
      </section>
      <div hidden={activePanel !== "managed"}>
        <ManagedEmbedWorkflow
          workflow={managedWorkflow}
          onOpenBuilder={openBuilderFromManagedEmbed}
        />
      </div>
    </div>
  );
}
