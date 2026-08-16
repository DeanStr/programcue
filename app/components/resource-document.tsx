import { ExternalLink, MapPin, Play } from "lucide-react";
import { Fragment, type ReactNode, useState } from "react";

import {
  ResourceContentError,
  type TiptapNode,
} from "~/modules/resources/resource-content";
import {
  type ExternalEmbed,
  externalEmbedPresentation,
  parseExternalEmbed,
  type ResourceEmbedConfiguration,
} from "~/modules/resources/resource-embed-policy";

function safeUrl(raw: unknown) {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    return ["https:", "mailto:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function textNode(node: TiptapNode, key: string): ReactNode {
  let content: ReactNode = node.text ?? "";
  for (const [index, mark] of (node.marks ?? []).entries()) {
    const markKey = `${key}:mark:${index}`;
    if (mark.type === "bold")
      content = <strong key={markKey}>{content}</strong>;
    if (mark.type === "italic") content = <em key={markKey}>{content}</em>;
    if (mark.type === "strike") content = <s key={markKey}>{content}</s>;
    if (mark.type === "code") content = <code key={markKey}>{content}</code>;
    if (mark.type === "link") {
      const href = safeUrl(mark.attrs?.href);
      if (href)
        content = (
          <a href={href} key={markKey} rel="noreferrer noopener">
            {content}
          </a>
        );
    }
  }
  return <Fragment key={key}>{content}</Fragment>;
}

function ExternalEmbedBlock({
  embed,
  configuration,
}: {
  embed: ExternalEmbed;
  configuration: ResourceEmbedConfiguration;
}) {
  const [loaded, setLoaded] = useState(false);
  const presentation = externalEmbedPresentation(embed, configuration);
  const Icon = embed.provider === "google_maps" ? MapPin : Play;
  return (
    <section
      className={`resource-external-embed resource-external-embed--${embed.provider}`}
      aria-label={presentation.contentLabel}
    >
      {loaded && presentation.embedUrl ? (
        <iframe
          className="resource-embed"
          src={presentation.embedUrl}
          title={presentation.contentLabel}
          loading="lazy"
          sandbox={presentation.sandbox}
          referrerPolicy={presentation.referrerPolicy}
          allow={presentation.allow}
          allowFullScreen
          style={{ aspectRatio: presentation.aspectRatio }}
        />
      ) : (
        <div className="resource-external-embed-placeholder">
          <Icon aria-hidden size={25} />
          <div>
            <strong>{presentation.contentLabel}</strong>
            <p>
              {presentation.enabled
                ? `Loading this content contacts ${presentation.providerLabel}.`
                : presentation.unavailableLabel}
            </p>
          </div>
          {presentation.enabled ? (
            <button
              className="btn primary small"
              type="button"
              onClick={() => setLoaded(true)}
            >
              {presentation.loadLabel}
            </button>
          ) : null}
        </div>
      )}
      <a
        className="resource-external-embed-link"
        href={presentation.sourceUrl}
        target="_blank"
        rel="noreferrer noopener"
      >
        {presentation.sourceLabel}
        <ExternalLink aria-hidden size={14} />
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    </section>
  );
}

function children(
  node: TiptapNode,
  configuration: ResourceEmbedConfiguration,
  key: string,
) {
  return (node.content ?? []).map((child, index) => {
    const positionKey = `${key}:${index}`;
    const childKey =
      child.type === "embed"
        ? `${positionKey}:${JSON.stringify(child.attrs ?? null)}`
        : positionKey;
    return resourceNode(child, configuration, childKey);
  });
}

function resourceNode(
  node: TiptapNode,
  configuration: ResourceEmbedConfiguration,
  key: string,
): ReactNode {
  switch (node.type) {
    case "doc":
      return (
        <Fragment key={key}>{children(node, configuration, key)}</Fragment>
      );
    case "text":
      return textNode(node, key);
    case "paragraph":
      return <p key={key}>{children(node, configuration, key)}</p>;
    case "heading": {
      const level = Math.min(4, Math.max(2, Number(node.attrs?.level) || 2));
      if (level === 3)
        return <h3 key={key}>{children(node, configuration, key)}</h3>;
      if (level === 4)
        return <h4 key={key}>{children(node, configuration, key)}</h4>;
      return <h2 key={key}>{children(node, configuration, key)}</h2>;
    }
    case "bulletList":
      return <ul key={key}>{children(node, configuration, key)}</ul>;
    case "orderedList":
      return <ol key={key}>{children(node, configuration, key)}</ol>;
    case "listItem":
      return <li key={key}>{children(node, configuration, key)}</li>;
    case "blockquote":
      return (
        <blockquote key={key}>{children(node, configuration, key)}</blockquote>
      );
    case "codeBlock":
      return (
        <pre key={key}>
          <code>{children(node, configuration, key)}</code>
        </pre>
      );
    case "horizontalRule":
      return <hr key={key} />;
    case "hardBreak":
      return <br key={key} />;
    case "embed":
      return (
        <ExternalEmbedBlock
          key={key}
          embed={parseExternalEmbed(node.attrs)}
          configuration={configuration}
        />
      );
    default:
      throw new ResourceContentError(
        `Resource node type ${node.type} is not allowed.`,
      );
  }
}

export function ResourceDocument({
  document,
  configuration,
}: {
  document: TiptapNode;
  configuration: ResourceEmbedConfiguration;
}) {
  return (
    <div className="resource-rendered">
      {resourceNode(document, configuration, "resource")}
    </div>
  );
}
