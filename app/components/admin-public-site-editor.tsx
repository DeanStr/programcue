import { ChevronDown, ChevronUp, Plus, Search, Trash2, X } from "lucide-react";
import { type Dispatch, type SetStateAction, useMemo, useState } from "react";
import { Form, Link } from "react-router";
import type { PublishedProgramme } from "~/modules/programme/public-programme-types";
import {
  PUBLIC_SITE_PAGE_TYPES,
  type PublicSiteDraft,
  type PublicSitePageType,
} from "~/modules/public-site/public-site";
import {
  publicSitePageDescriptions,
  publicSiteSectionLabels,
} from "./admin-public-site-constants";

type FeaturedPickerItem = {
  id: string;
  title: string;
  metadata: string;
  searchText: string;
  unavailable?: boolean;
};

function OrderedFeaturedPicker({
  label,
  recordKind,
  items,
  canAdd,
  selectedIds,
  setSelectedIds,
  unavailableMessage,
}: {
  label: string;
  recordKind: "session" | "speaker";
  items: FeaturedPickerItem[] | null;
  canAdd: boolean;
  selectedIds: string[];
  setSelectedIds(update: (current: string[]) => string[]): void;
  unavailableMessage: string;
}) {
  const [query, setQuery] = useState("");
  const itemById = useMemo(
    () => new Map(items?.map((item) => [item.id, item]) ?? []),
    [items],
  );
  const selected = useMemo(
    () =>
      selectedIds.map(
        (id) =>
          itemById.get(id) ?? {
            id,
            title: `Remove unavailable selected ${recordKind}: ${id}`,
            metadata: "Remove this stale selection before publication.",
            searchText: id,
            unavailable: true,
          },
      ),
    [itemById, recordKind, selectedIds],
  );
  const normalisedQuery = query.trim().toLowerCase();
  const available = useMemo(() => {
    const selectedSet = new Set(selectedIds);
    return (items ?? []).filter(
      (item) =>
        !selectedSet.has(item.id) &&
        (!normalisedQuery ||
          item.searchText.toLowerCase().includes(normalisedQuery)),
    );
  }, [items, normalisedQuery, selectedIds]);
  const visibleAvailable = available.slice(0, 20);

  function move(index: number, direction: -1 | 1) {
    setSelectedIds((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  return (
    <fieldset className="public-site-featured-picker mt">
      <legend>{label}</legend>
      <div className="card-title">
        <div>
          <strong>Featured · {selected.length} of 12</strong>
          <p className="help">
            This order is the public homepage display order.
          </p>
        </div>
      </div>
      {selected.length ? (
        <ol className="public-site-featured-selected">
          {selected.map((item, index) => (
            <li key={item.id}>
              <span>
                <strong>{item.title}</strong>
                {item.metadata ? <small>{item.metadata}</small> : null}
              </span>
              <div className="public-site-order-actions">
                <button
                  type="button"
                  className="icon-btn"
                  disabled={index === 0}
                  aria-label={`Move up ${item.title}`}
                  onClick={() => move(index, -1)}
                >
                  <ChevronUp aria-hidden size={14} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  disabled={index === selected.length - 1}
                  aria-label={`Move down ${item.title}`}
                  onClick={() => move(index, 1)}
                >
                  <ChevronDown aria-hidden size={14} />
                </button>
                <button
                  type="button"
                  className="btn small"
                  aria-label={
                    item.unavailable ? item.title : `Remove ${item.title}`
                  }
                  onClick={() =>
                    setSelectedIds((current) =>
                      current.filter((id) => id !== item.id),
                    )
                  }
                >
                  <X aria-hidden size={14} /> Remove
                </button>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="help">No records selected.</p>
      )}
      {!items || !canAdd ? (
        <p className="help">{unavailableMessage}</p>
      ) : (
        <>
          <label className="label mt">
            <span>
              <Search aria-hidden size={14} /> Search available
            </span>
            <input
              className="field"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <p className="help" role="status">
            {available.length > visibleAvailable.length
              ? `Showing ${visibleAvailable.length} of ${available.length} ${
                  normalisedQuery ? "matches" : "available records"
                }. Type to search.`
              : `${available.length} available ${
                  available.length === 1 ? "record" : "records"
                }${normalisedQuery ? " match" : ""}.`}
          </p>
          <div className="public-site-featured-available">
            {visibleAvailable.map((item) => (
              <div key={item.id}>
                <span>
                  <strong>{item.title}</strong>
                  {item.metadata ? <small>{item.metadata}</small> : null}
                </span>
                <button
                  type="button"
                  className="btn small"
                  disabled={selected.length >= 12}
                  aria-label={`Add ${item.title}`}
                  onClick={() =>
                    setSelectedIds((current) => [...current, item.id])
                  }
                >
                  <Plus aria-hidden size={14} /> Add
                </button>
              </div>
            ))}
            {!available.length ? (
              <p className="help">
                {normalisedQuery
                  ? "No available records match this search."
                  : "Every available record is already featured."}
              </p>
            ) : null}
          </div>
        </>
      )}
    </fieldset>
  );
}

function SitePageEditor({
  page,
  value,
  setConfiguration,
}: {
  page: PublicSitePageType;
  value: PublicSiteDraft["pages"][PublicSitePageType];
  setConfiguration: Dispatch<SetStateAction<PublicSiteDraft>>;
}) {
  const [open, setOpen] = useState(false);
  function update(
    change: Partial<PublicSiteDraft["pages"][PublicSitePageType]>,
  ) {
    setConfiguration((current) => ({
      ...current,
      pages: {
        ...current.pages,
        [page]: { ...current.pages[page], ...change },
      },
    }));
  }
  return (
    <fieldset>
      <legend>{value.title}</legend>
      <div className="public-site-page-row">
        <div>
          <strong>{value.navigationLabel}</strong>
          <p className="help">{publicSitePageDescriptions[page]}</p>
        </div>
        <label>
          <input
            type="checkbox"
            checked={value.enabled}
            onChange={(event) => {
              update({ enabled: event.target.checked });
              if (event.target.checked) setOpen(true);
            }}
          />{" "}
          Publish this page with the site
        </label>
      </div>
      <details
        className="pc-disclosure mt"
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary>
          <strong>Edit page content</strong>
          <span className="help">
            {value.enabled
              ? "Published with the next site version"
              : "Not enabled"}
          </span>
        </summary>
        <div className="stack mt">
          <label className="label">
            Title
            <input
              className="field"
              maxLength={100}
              value={value.title}
              onChange={(event) => update({ title: event.target.value })}
            />
          </label>
          <label className="label">
            Navigation label
            <input
              className="field"
              maxLength={40}
              value={value.navigationLabel}
              onChange={(event) =>
                update({ navigationLabel: event.target.value })
              }
            />
          </label>
          <label className="label">
            Restricted Markdown
            <textarea
              className="textarea"
              maxLength={8000}
              rows={5}
              value={value.body}
              onChange={(event) => update({ body: event.target.value })}
            />
          </label>
        </div>
      </details>
    </fieldset>
  );
}

function SiteSectionControls({
  configuration,
  setConfiguration,
  programmeAvailable,
  programmeReferencesAvailable,
}: {
  configuration: PublicSiteDraft;
  setConfiguration: Dispatch<SetStateAction<PublicSiteDraft>>;
  programmeAvailable: boolean;
  programmeReferencesAvailable: boolean;
}) {
  function move(index: number, direction: -1 | 1) {
    setConfiguration((current) => {
      const next = [...current.sectionOrder];
      const target = index + direction;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target], next[index]];
      return { ...current, sectionOrder: next };
    });
  }
  return (
    <ol className="public-site-section-order">
      {configuration.sectionOrder.map((section, index) => (
        <li key={section}>
          <label>
            <input
              type="checkbox"
              checked={configuration.sectionVisibility[section]}
              disabled={
                !configuration.sectionVisibility[section] &&
                ((!programmeAvailable &&
                  [
                    "featured_speakers",
                    "featured_sessions",
                    "statistics",
                  ].includes(section)) ||
                  (!programmeReferencesAvailable &&
                    ["featured_speakers", "featured_sessions"].includes(
                      section,
                    )))
              }
              onChange={(event) =>
                setConfiguration((current) => ({
                  ...current,
                  sectionVisibility: {
                    ...current.sectionVisibility,
                    [section]: event.target.checked,
                  },
                }))
              }
            />
            <span>
              <strong>{publicSiteSectionLabels[section]}</strong>
              <small>
                {configuration.sectionVisibility[section] ? "Shown" : "Hidden"}
              </small>
            </span>
          </label>
          <div className="public-site-order-actions">
            <button
              type="button"
              className="icon-btn"
              disabled={index === 0}
              aria-label={`Move up ${publicSiteSectionLabels[section]}`}
              onClick={() => move(index, -1)}
            >
              <ChevronUp aria-hidden size={14} />
            </button>
            <button
              type="button"
              className="icon-btn"
              disabled={index === configuration.sectionOrder.length - 1}
              aria-label={`Move down ${publicSiteSectionLabels[section]}`}
              onClick={() => move(index, 1)}
            >
              <ChevronDown aria-hidden size={14} />
            </button>
          </div>
        </li>
      ))}
    </ol>
  );
}

export function AdminPublicSiteEditor({
  configuration,
  setConfiguration,
  draftRevision,
  serializedConfiguration,
  programme,
  programmeReferencesAvailable,
  unsaved,
  busy,
  saving,
}: {
  configuration: PublicSiteDraft;
  setConfiguration: Dispatch<SetStateAction<PublicSiteDraft>>;
  draftRevision: number;
  serializedConfiguration: string;
  programme: PublishedProgramme | null;
  programmeReferencesAvailable: boolean;
  unsaved: boolean;
  busy: boolean;
  saving: boolean;
}) {
  const commandId = useMemo(
    () => ({ revision: draftRevision, id: crypto.randomUUID() }),
    [draftRevision],
  ).id;
  const speakerItems = useMemo(
    () =>
      programme
        ? programme.speakers.map((speaker) => {
            const metadata = [speaker.jobTitle, speaker.organisationName]
              .filter(Boolean)
              .join(" · ");
            return {
              id: speaker.id,
              title: speaker.displayName,
              metadata,
              searchText: `${speaker.displayName} ${metadata}`,
            };
          })
        : null,
    [programme],
  );
  const sessionItems = useMemo(
    () =>
      programme
        ? programme.sessions.map((session) => {
            const metadata = [session.track, session.format, session.room]
              .filter(Boolean)
              .join(" · ");
            return {
              id: session.id,
              title: session.title,
              metadata,
              searchText: `${session.title} ${metadata} ${session.speakerNames.join(" ")}`,
            };
          })
        : null,
    [programme],
  );
  const enabledPages = PUBLIC_SITE_PAGE_TYPES.filter(
    (page) => configuration.pages[page].enabled,
  );
  return (
    <Form method="post" className="public-site-rail-form">
      <input type="hidden" name="intent" value="save-site" />
      <input type="hidden" name="commandId" value={commandId} />
      <input type="hidden" name="revision" value={draftRevision} />
      <input
        type="hidden"
        name="configurationJson"
        value={serializedConfiguration}
      />
      <div className="card-title">
        <div>
          <h2 className="public-site-rail-title">Site identity and theme</h2>
          <p className="help public-site-rail-help">
            Draft {draftRevision || "not saved"}
          </p>
        </div>
      </div>
      <label className="label">
        Tagline
        <input
          className="field"
          maxLength={180}
          value={configuration.tagline}
          onChange={(event) =>
            setConfiguration((current) => ({
              ...current,
              tagline: event.target.value,
            }))
          }
        />
      </label>
      <label className="label mt">
        Theme
        <select
          className="field"
          value={configuration.theme}
          onChange={(event) =>
            setConfiguration((current) => ({
              ...current,
              theme: event.target.value as PublicSiteDraft["theme"],
            }))
          }
        >
          <option value="system">Follow visitor system</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>

      <div className="card-title mt">
        <div>
          <h2 className="public-site-rail-title">Homepage sections</h2>
          <p className="help">Shown sections appear in this order.</p>
        </div>
      </div>
      <SiteSectionControls
        configuration={configuration}
        setConfiguration={setConfiguration}
        programmeAvailable={programme !== null}
        programmeReferencesAvailable={programmeReferencesAvailable}
      />

      <label className="label mt">
        Introduction heading
        <input
          className="field"
          maxLength={100}
          value={configuration.introductionHeading}
          onChange={(event) =>
            setConfiguration((current) => ({
              ...current,
              introductionHeading: event.target.value,
            }))
          }
        />
      </label>
      <p className="help">
        The introduction body uses the existing Event Setup description.{" "}
        <Link to="/admin/event">Edit event details</Link>.
      </p>

      <OrderedFeaturedPicker
        label="Featured speakers"
        recordKind="speaker"
        items={speakerItems}
        canAdd={programmeReferencesAvailable}
        selectedIds={configuration.featuredSpeakerIds}
        setSelectedIds={(update) =>
          setConfiguration((current) => ({
            ...current,
            featuredSpeakerIds: update(current.featuredSpeakerIds),
          }))
        }
        unavailableMessage={
          programme
            ? "Featured programme content is unavailable for this event's programme source. Existing selections can be removed."
            : "Publish a programme before choosing speakers."
        }
      />
      <OrderedFeaturedPicker
        label="Featured sessions"
        recordKind="session"
        items={sessionItems}
        canAdd={programmeReferencesAvailable}
        selectedIds={configuration.featuredSessionIds}
        setSelectedIds={(update) =>
          setConfiguration((current) => ({
            ...current,
            featuredSessionIds: update(current.featuredSessionIds),
          }))
        }
        unavailableMessage={
          programme
            ? "Featured programme content is unavailable for this event's programme source. Existing selections can be removed."
            : "Publish a programme before choosing sessions."
        }
      />
      <fieldset className="public-site-selection mt">
        <legend>Statistics</legend>
        {Object.entries(configuration.statisticVisibility).map(
          ([statistic, checked]) => (
            <label key={statistic}>
              <input
                type="checkbox"
                checked={checked}
                onChange={(event) =>
                  setConfiguration((current) => ({
                    ...current,
                    statisticVisibility: {
                      ...current.statisticVisibility,
                      [statistic]: event.target.checked,
                    },
                  }))
                }
              />{" "}
              {statistic}
            </label>
          ),
        )}
      </fieldset>

      <details className="pc-disclosure public-site-form-disclosure mt">
        <summary>
          <strong>FAQ</strong>
          <span className="help">
            {configuration.faqItems.length
              ? `${configuration.faqItems.length} question${
                  configuration.faqItems.length === 1 ? "" : "s"
                } · ${configuration.faqItems
                  .slice(0, 2)
                  .map((item) => item.question.trim() || "Untitled")
                  .join(" · ")}`
              : "No questions"}
          </span>
        </summary>
        <p className="help">
          Answers support paragraphs, headings, lists, bold and HTTPS links.
        </p>
        <div className="card-title">
          <button
            className="btn small"
            type="button"
            disabled={configuration.faqItems.length >= 12}
            onClick={() =>
              setConfiguration((current) => ({
                ...current,
                faqItems: [
                  ...current.faqItems,
                  { id: crypto.randomUUID(), question: "", answer: "" },
                ],
              }))
            }
          >
            <Plus aria-hidden size={14} /> Add question
          </button>
        </div>
        <div className="public-site-faq-editor">
          {configuration.faqItems.map((item, index) => (
            <fieldset key={item.id}>
              <legend>Question {index + 1}</legend>
              <label className="label">
                Question
                <input
                  className="field"
                  maxLength={180}
                  value={item.question}
                  onChange={(event) =>
                    setConfiguration((current) => ({
                      ...current,
                      faqItems: current.faqItems.map((candidate) =>
                        candidate.id === item.id
                          ? { ...candidate, question: event.target.value }
                          : candidate,
                      ),
                    }))
                  }
                />
              </label>
              <label className="label mt">
                Answer
                <textarea
                  className="textarea"
                  maxLength={2000}
                  rows={4}
                  value={item.answer}
                  onChange={(event) =>
                    setConfiguration((current) => ({
                      ...current,
                      faqItems: current.faqItems.map((candidate) =>
                        candidate.id === item.id
                          ? { ...candidate, answer: event.target.value }
                          : candidate,
                      ),
                    }))
                  }
                />
              </label>
              <button
                className="btn small mt"
                type="button"
                aria-label={`Remove FAQ item ${index + 1}`}
                onClick={() =>
                  setConfiguration((current) => ({
                    ...current,
                    faqItems: current.faqItems.filter(
                      (candidate) => candidate.id !== item.id,
                    ),
                  }))
                }
              >
                <Trash2 aria-hidden size={14} /> Remove
              </button>
              <div className="public-site-order-actions mt">
                <button
                  className="icon-btn"
                  type="button"
                  disabled={index === 0}
                  aria-label={`Move up FAQ item ${index + 1}`}
                  onClick={() =>
                    setConfiguration((current) => {
                      const faqItems = [...current.faqItems];
                      [faqItems[index - 1], faqItems[index]] = [
                        faqItems[index],
                        faqItems[index - 1],
                      ];
                      return { ...current, faqItems };
                    })
                  }
                >
                  <ChevronUp aria-hidden size={14} />
                </button>
                <button
                  className="icon-btn"
                  type="button"
                  disabled={index === configuration.faqItems.length - 1}
                  aria-label={`Move down FAQ item ${index + 1}`}
                  onClick={() =>
                    setConfiguration((current) => {
                      const faqItems = [...current.faqItems];
                      [faqItems[index], faqItems[index + 1]] = [
                        faqItems[index + 1],
                        faqItems[index],
                      ];
                      return { ...current, faqItems };
                    })
                  }
                >
                  <ChevronDown aria-hidden size={14} />
                </button>
              </div>
            </fieldset>
          ))}
        </div>
      </details>

      <details className="pc-disclosure public-site-form-disclosure mt">
        <summary>
          <strong>Event pages</strong>
          <span className="help">
            {enabledPages.length} of {PUBLIC_SITE_PAGE_TYPES.length} published
            {enabledPages.length
              ? ` · ${enabledPages
                  .slice(0, 3)
                  .map((page) => configuration.pages[page].navigationLabel)
                  .join(" · ")}`
              : ""}
          </span>
        </summary>
        <p className="help">
          Five fixed pages, no nesting or arbitrary routes.
        </p>
        <div className="public-site-page-editor">
          {PUBLIC_SITE_PAGE_TYPES.map((page) => (
            <SitePageEditor
              key={page}
              page={page}
              value={configuration.pages[page]}
              setConfiguration={setConfiguration}
            />
          ))}
        </div>
      </details>

      <details className="pc-disclosure public-site-form-disclosure mt">
        <summary>
          <strong>Post-event mode</strong>
          <span className="help">
            {configuration.postEvent.enabled
              ? "Recordings shown after the event"
              : "Off"}
          </span>
        </summary>
        <fieldset className="public-site-post-event">
          <legend>Post-event recordings</legend>
          <label>
            <input
              type="checkbox"
              checked={configuration.postEvent.enabled}
              disabled={
                (!programme || !programmeReferencesAvailable) &&
                !configuration.postEvent.enabled
              }
              onChange={(event) =>
                setConfiguration((current) => ({
                  ...current,
                  postEvent: {
                    ...current.postEvent,
                    enabled: event.target.checked,
                  },
                }))
              }
            />{" "}
            Show published recordings after the event ends
          </label>
          {!programmeReferencesAvailable ? (
            <p className="help">
              Post-event recordings are unavailable for this event's programme
              source.
            </p>
          ) : null}
          <label className="label mt">
            Heading
            <input
              className="field"
              maxLength={120}
              value={configuration.postEvent.heading}
              onChange={(event) =>
                setConfiguration((current) => ({
                  ...current,
                  postEvent: {
                    ...current.postEvent,
                    heading: event.target.value,
                  },
                }))
              }
            />
          </label>
          <label className="label mt">
            Introduction
            <textarea
              className="textarea"
              maxLength={2000}
              rows={3}
              value={configuration.postEvent.body}
              onChange={(event) =>
                setConfiguration((current) => ({
                  ...current,
                  postEvent: {
                    ...current.postEvent,
                    body: event.target.value,
                  },
                }))
              }
            />
          </label>
        </fieldset>
      </details>

      <div className="page-actions mt">
        <button
          className="btn primary"
          type="submit"
          disabled={!unsaved || busy}
        >
          {saving
            ? "Saving…"
            : draftRevision === 0
              ? "Create website draft"
              : "Save website draft"}
        </button>
      </div>
    </Form>
  );
}
