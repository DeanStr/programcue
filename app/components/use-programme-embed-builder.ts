import { useState } from "react";
import { useActionData } from "react-router";
import { requireValue } from "~/lib/required-value";
import {
  defaultProgrammeEmbedConfiguration,
  managedProgrammeEmbedUrl,
  managedProgrammeWidgetSnippet,
  PROGRAMME_EMBED_CONTROLS,
  PROGRAMME_EMBED_FIELDS,
  type ProgrammeEmbedConfiguration,
  ProgrammeEmbedConfigurationError,
  type ProgrammeEmbedControl,
  type ProgrammeEmbedField,
  type ProgrammeEmbedSurface,
  parseProgrammeEmbedHeight,
  programmeEmbedFilterOptions,
  programmeEmbedUrl,
  programmeIframeSnippet,
  programmeWidgetSnippet,
} from "~/modules/programme/programme-embed-configuration";
import type { ManagedProgrammeEmbed } from "~/modules/programme/programme-embed-service.server";

export type ProgrammeEmbedSession = {
  startsAt: number | null;
  status: string;
  track: string | null;
  format: string;
  room: string | null;
  visibility: string;
};

export type ProgrammeEmbedOutput = "iframe" | "widget";
export type ProgrammeEmbedPreviewWidth = "desktop" | "mobile";
export type ProgrammeEmbedCopyState = "idle" | "copied" | "failed";
type EmbedActionData = { ok?: boolean; message?: string } | undefined;

export const programmeEmbedSurfaceLabels: Record<
  ProgrammeEmbedSurface,
  string
> = {
  sessions: "Programme / session list",
  speakers: "Speakers list",
  agenda: "Agenda",
  schedule: "Schedule itinerary",
  gallery: "Speaker gallery",
};

export function useProgrammeEmbedBuilder({
  publicOrigin,
  publicSlug,
  eventName,
  timezone,
  sessions,
  managedEmbeds,
}: {
  publicOrigin: string;
  publicSlug: string;
  eventName: string;
  timezone: string;
  sessions: ProgrammeEmbedSession[];
  managedEmbeds: ManagedProgrammeEmbed[];
}) {
  const actionData = useActionData() as EmbedActionData;
  const [configuration, setConfiguration] =
    useState<ProgrammeEmbedConfiguration>(defaultProgrammeEmbedConfiguration);
  const [heightInput, setHeightInput] = useState(
    String(defaultProgrammeEmbedConfiguration().height),
  );
  const [output, setOutput] = useState<ProgrammeEmbedOutput>("iframe");
  const [previewWidth, setPreviewWidth] =
    useState<ProgrammeEmbedPreviewWidth>("desktop");
  const [copyState, setCopyState] = useState<ProgrammeEmbedCopyState>("idle");
  const [selectedEmbedId, setSelectedEmbedId] = useState<string | null>(null);
  const [managedName, setManagedName] = useState("");
  const [managedSlug, setManagedSlug] = useState("");
  const [installationNote, setInstallationNote] = useState("");
  const [managedConfirmed, setManagedConfirmed] = useState(false);
  const { days, tracks, formats, rooms } = programmeEmbedFilterOptions(
    sessions,
    timezone,
  );
  const previewUrl = programmeEmbedUrl(publicOrigin, publicSlug, configuration);
  const target = `programcue-${publicSlug}-${configuration.surface}`;
  const title = `${eventName} ${programmeEmbedSurfaceLabels[configuration.surface]}`;
  let parsedHeight: number | null = null;
  let heightError: string | null = null;
  try {
    parsedHeight = parseProgrammeEmbedHeight(heightInput);
  } catch (error) {
    if (error instanceof ProgrammeEmbedConfigurationError) {
      heightError = error.message;
    } else {
      throw error;
    }
  }
  const outputConfiguration =
    parsedHeight === null ? null : { ...configuration, height: parsedHeight };
  const code =
    outputConfiguration === null
      ? ""
      : output === "iframe"
        ? programmeIframeSnippet(previewUrl, title, outputConfiguration.height)
        : programmeWidgetSnippet({
            origin: publicOrigin,
            eventSlug: publicSlug,
            target,
            title,
            configuration: outputConfiguration,
          });
  const selectedEmbed = managedEmbeds.find(
    (embed) => embed.id === selectedEmbedId,
  );
  const selectedManagedUrl = selectedEmbed
    ? managedProgrammeEmbedUrl(publicOrigin, publicSlug, selectedEmbed.slug)
    : null;
  const selectedManagedCode =
    selectedEmbed && outputConfiguration
      ? output === "iframe"
        ? programmeIframeSnippet(
            requireValue(
              selectedManagedUrl,
              "Required selectedManagedUrl is unavailable.",
            ),
            `${eventName} ${selectedEmbed.name}`,
            outputConfiguration.height,
          )
        : managedProgrammeWidgetSnippet({
            origin: publicOrigin,
            eventSlug: publicSlug,
            embedSlug: selectedEmbed.slug,
            target: `programcue-${publicSlug}-${selectedEmbed.slug}`,
            title: `${eventName} ${selectedEmbed.name}`,
            height: outputConfiguration.height,
          })
      : "";
  const changedConfigurationFields = selectedEmbed
    ? (
        Object.keys(selectedEmbed.configuration) as Array<
          keyof ProgrammeEmbedConfiguration
        >
      ).filter(
        (key) =>
          JSON.stringify(selectedEmbed.configuration[key]) !==
          JSON.stringify(outputConfiguration?.[key]),
      )
    : [];

  function update<Key extends keyof ProgrammeEmbedConfiguration>(
    key: Key,
    value: ProgrammeEmbedConfiguration[Key],
  ) {
    setConfiguration((current) => ({ ...current, [key]: value }));
    setCopyState("idle");
    setManagedConfirmed(false);
  }

  function toggleControl(control: ProgrammeEmbedControl) {
    update(
      "controls",
      configuration.controls.includes(control)
        ? configuration.controls.filter((value) => value !== control)
        : PROGRAMME_EMBED_CONTROLS.filter(
            (value) =>
              value === control || configuration.controls.includes(value),
          ),
    );
  }

  function toggleField(field: ProgrammeEmbedField) {
    update(
      "fields",
      configuration.fields.includes(field)
        ? configuration.fields.filter((value) => value !== field)
        : PROGRAMME_EMBED_FIELDS.filter(
            (value) => value === field || configuration.fields.includes(value),
          ),
    );
  }

  async function copyCode() {
    if (!navigator.clipboard?.writeText) {
      setCopyState("failed");
      return;
    }
    try {
      await navigator.clipboard.writeText(code);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  function reset() {
    const defaults = defaultProgrammeEmbedConfiguration();
    setConfiguration(defaults);
    setHeightInput(String(defaults.height));
    setOutput("iframe");
    setPreviewWidth("desktop");
    setCopyState("idle");
    setSelectedEmbedId(null);
    setManagedName("");
    setManagedSlug("");
    setInstallationNote("");
    setManagedConfirmed(false);
  }

  function loadManagedEmbed(embed: ManagedProgrammeEmbed) {
    setSelectedEmbedId(embed.id);
    setManagedName(embed.name);
    setManagedSlug(embed.slug);
    setInstallationNote(embed.installationNote ?? "");
    setConfiguration({
      ...embed.configuration,
      controls: [...embed.configuration.controls],
      fields: [...embed.configuration.fields],
    });
    setHeightInput(String(embed.configuration.height));
    setManagedConfirmed(false);
    setCopyState("idle");
  }

  return {
    configurationWorkflow: {
      configuration,
      days,
      tracks,
      formats,
      rooms,
      heightInput,
      heightError,
      previewWidth,
      previewUrl,
      eventName,
      output,
      code,
      copyState,
      publicSlug,
      reset,
      update,
      toggleControl,
      toggleField,
      setHeightInput,
      setCopyState,
      setManagedConfirmed,
      setPreviewWidth,
      setOutput,
      copyCode,
    },
    managedWorkflow: {
      actionData,
      selectedEmbed,
      outputConfiguration,
      managedName,
      managedSlug,
      publicSlug,
      installationNote,
      changedConfigurationFields,
      managedConfirmed,
      selectedManagedUrl,
      output,
      selectedManagedCode,
      managedEmbeds,
      timezone,
      selectedEmbedId,
      reset,
      setManagedName,
      setManagedSlug,
      setInstallationNote,
      setManagedConfirmed,
      loadManagedEmbed,
    },
  };
}

export type ProgrammeEmbedBuilderController = ReturnType<
  typeof useProgrammeEmbedBuilder
>;
