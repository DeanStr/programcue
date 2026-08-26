import { ChevronDown, ChevronUp, Plus, Search, Trash2, X } from "lucide-react";
import {
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useMemo,
  useState,
} from "react";
import { Form, Link } from "react-router";
import { Button, IconButton } from "~/components/ui/button";
import type { PublishedProgramme } from "~/modules/programme/public-programme-types";
import {
  PUBLIC_SITE_PAGE_TYPES,
  type PublicSiteDraft,
  type PublicSitePageType,
  type PublicSiteSectionType,
} from "~/modules/public-site/public-site";
import {
  type PublicSiteStatisticType,
  publicSitePageDescriptions,
  publicSiteSectionDescriptions,
  publicSiteSectionLabels,
  publicSiteStatisticLabels,
} from "./admin-public-site-constants";
import { SitePanelHeading } from "./admin-public-site-panels";
import { RestrictedMarkdownEditor } from "./restricted-markdown-editor";

export type PublicSiteEditorPanel = "homepage" | "pages";

type FeaturedPickerItem = {
  id: string;
  title: string;
  metadata: string;
  searchText: string;
  unavailable?: boolean;
};

const PROGRAMME_BACKED_SECTIONS: PublicSiteSectionType[] = [
  "featured_speakers",
  "featured_sessions",
  "statistics",
];
const PROGRAMME_REFERENCE_SECTIONS: PublicSiteSectionType[] = [
  "featured_speakers",
  "featured_sessions",
];

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
  const atCapacity = selected.length >= 12;

  /* One line under the search field answers the only question it can raise:
     what is on offer, or why nothing can be added. */
  function availability() {
    if (atCapacity)
      return "Twelve records are featured, which is the maximum. Remove one to choose another.";
    if (!available.length)
      return normalisedQuery
        ? "No available records match this search."
        : "Every available record is already featured.";
    if (available.length > visibleAvailable.length)
      return `Showing ${visibleAvailable.length} of ${available.length} ${
        normalisedQuery ? "matches" : "available records"
      }. Type to search.`;
    return `${available.length} available ${
      available.length === 1 ? "record" : "records"
    }${normalisedQuery ? " match" : ""}.`;
  }

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
    <fieldset className="public-site-featured-picker">
      {/* The section row above already names this picker. The legend stays for
          the group's accessible name rather than printing the title twice. */}
      <legend className="sr-only">{label}</legend>
      <p className="public-site-featured-count">
        <strong>Featured · {selected.length} of 12</strong>
        <span className="help">
          This order is the public homepage display order.
        </span>
      </p>
      {selected.length ? (
        <ol className="public-site-featured-selected">
          {selected.map((item, index) => (
            <li key={item.id}>
              <span>
                <strong>{item.title}</strong>
                {item.metadata ? <small>{item.metadata}</small> : null}
              </span>
              <div className="public-site-order-actions">
                <IconButton
                  disabled={index === 0}
                  aria-label={`Move up ${item.title}`}
                  onClick={() => move(index, -1)}
                >
                  <ChevronUp aria-hidden size={14} />
                </IconButton>
                <IconButton
                  disabled={index === selected.length - 1}
                  aria-label={`Move down ${item.title}`}
                  onClick={() => move(index, 1)}
                >
                  <ChevronDown aria-hidden size={14} />
                </IconButton>
                <IconButton
                  className="danger"
                  aria-label={
                    item.unavailable ? item.title : `Remove ${item.title}`
                  }
                  onClick={() =>
                    setSelectedIds((current) =>
                      current.filter((id) => id !== item.id),
                    )
                  }
                >
                  <X aria-hidden size={14} />
                </IconButton>
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
          <label className="label">
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
            {availability()}
          </p>
          {available.length ? (
            <div className="public-site-featured-available">
              {visibleAvailable.map((item) => (
                <div key={item.id}>
                  <span>
                    <strong>{item.title}</strong>
                    {item.metadata ? <small>{item.metadata}</small> : null}
                  </span>
                  <Button
                    size="small"
                    disabled={atCapacity}
                    aria-label={`Add ${item.title}`}
                    onClick={() =>
                      setSelectedIds((current) => [...current, item.id])
                    }
                  >
                    <Plus aria-hidden size={14} /> Add
                  </Button>
                </div>
              ))}
            </div>
          ) : null}
        </>
      )}
    </fieldset>
  );
}

function FaqEditor({
  configuration,
  setConfiguration,
}: {
  configuration: PublicSiteDraft;
  setConfiguration: Dispatch<SetStateAction<PublicSiteDraft>>;
}) {
  function move(index: number, direction: -1 | 1) {
    setConfiguration((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.faqItems.length) return current;
      const faqItems = [...current.faqItems];
      [faqItems[index], faqItems[target]] = [faqItems[target], faqItems[index]];
      return { ...current, faqItems };
    });
  }
  return (
    <>
      <p className="help">
        Answers support paragraphs, headings, lists, bold and HTTPS links.
      </p>
      <div className="public-site-faq-editor">
        {configuration.faqItems.map((item, index) => (
          <fieldset key={item.id}>
            <legend className="sr-only">Question {index + 1}</legend>
            <div className="public-site-record-head">
              <strong>Question {index + 1}</strong>
              <div className="public-site-order-actions">
                <IconButton
                  disabled={index === 0}
                  aria-label={`Move up FAQ item ${index + 1}`}
                  onClick={() => move(index, -1)}
                >
                  <ChevronUp aria-hidden size={14} />
                </IconButton>
                <IconButton
                  disabled={index === configuration.faqItems.length - 1}
                  aria-label={`Move down FAQ item ${index + 1}`}
                  onClick={() => move(index, 1)}
                >
                  <ChevronDown aria-hidden size={14} />
                </IconButton>
                <IconButton
                  className="danger"
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
                  <Trash2 aria-hidden size={14} />
                </IconButton>
              </div>
            </div>
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
            <RestrictedMarkdownEditor
              label="Answer"
              maximumLength={2_000}
              value={item.answer}
              onChange={(answer) =>
                setConfiguration((current) => ({
                  ...current,
                  faqItems: current.faqItems.map((candidate) =>
                    candidate.id === item.id
                      ? { ...candidate, answer }
                      : candidate,
                  ),
                }))
              }
            />
          </fieldset>
        ))}
      </div>
      <div className="page-actions">
        <Button
          size="small"
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
        </Button>
      </div>
    </>
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
    <fieldset data-enabled={value.enabled}>
      <legend className="sr-only">{value.title}</legend>
      <div className="public-site-page-row">
        <div>
          <strong>{value.title}</strong>
          <p className="help">{publicSitePageDescriptions[page]}</p>
        </div>
        <label className="public-site-inline-check">
          <input
            type="checkbox"
            checked={value.enabled}
            onChange={(event) => {
              update({ enabled: event.target.checked });
              if (event.target.checked) setOpen(true);
            }}
          />
          <span>Publish this page with the site</span>
        </label>
      </div>
      <details
        className="pc-disclosure public-site-page-content"
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary>
          <strong>Edit page content</strong>
          <span className="help">Navigation: {value.navigationLabel}</span>
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
          <RestrictedMarkdownEditor
            label="Page content"
            maximumLength={8_000}
            value={value.body}
            onChange={(body) => update({ body })}
          />
        </div>
      </details>
    </fieldset>
  );
}

/* The homepage is an ordered list of sections, so the editor is that same list.
   Reordering, showing and composing a section were three controls in three
   places on this page; venue had no editor at all and the FAQ's lived several
   screens below the row that switched it on. */
function HomepageSectionRow({
  section,
  index,
  total,
  visible,
  disabled,
  summary,
  onToggle,
  onMove,
  children,
}: {
  section: PublicSiteSectionType;
  index: number;
  total: number;
  visible: boolean;
  disabled: boolean;
  summary: string;
  onToggle(next: boolean): void;
  onMove(direction: -1 | 1): void;
  children: ReactNode;
}) {
  const label = publicSiteSectionLabels[section];
  return (
    <li className="public-site-section-row" data-visible={visible}>
      <details className="public-site-section-editor">
        <summary>
          <span className="public-site-section-name">
            <strong>{label}</strong>
            <span className="help">{summary}</span>
          </span>
        </summary>
        <div className="public-site-section-body">{children}</div>
      </details>
      <div className="public-site-section-controls">
        <label className="public-site-section-visibility">
          <input
            type="checkbox"
            checked={visible}
            disabled={disabled}
            aria-label={`Show ${label} on the homepage`}
            onChange={(event) => onToggle(event.target.checked)}
          />
          <span aria-hidden="true">{visible ? "Shown" : "Hidden"}</span>
        </label>
        <div className="public-site-order-actions">
          <IconButton
            disabled={index === 0}
            aria-label={`Move up ${label}`}
            onClick={() => onMove(-1)}
          >
            <ChevronUp aria-hidden size={14} />
          </IconButton>
          <IconButton
            disabled={index === total - 1}
            aria-label={`Move down ${label}`}
            onClick={() => onMove(1)}
          >
            <ChevronDown aria-hidden size={14} />
          </IconButton>
        </div>
      </div>
    </li>
  );
}

export function AdminPublicSiteEditor({
  configuration,
  setConfiguration,
  draftRevision,
  serializedConfiguration,
  programme,
  programmeReferencesAvailable,
  formId,
  activePanel,
}: {
  configuration: PublicSiteDraft;
  setConfiguration: Dispatch<SetStateAction<PublicSiteDraft>>;
  draftRevision: number;
  serializedConfiguration: string;
  programme: PublishedProgramme | null;
  programmeReferencesAvailable: boolean;
  formId: string;
  activePanel: PublicSiteEditorPanel | null;
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
  const programmeAvailable = programme !== null;
  const unavailableMessage = programmeAvailable
    ? "Featured programme content is unavailable for this event's programme source. Existing selections can be removed."
    : "Publish a programme before choosing speakers or sessions.";
  const statistics = Object.entries(configuration.statisticVisibility) as [
    PublicSiteStatisticType,
    boolean,
  ][];
  const shownStatistics = statistics.filter(([, shown]) => shown);

  function moveSection(index: number, direction: -1 | 1) {
    setConfiguration((current) => {
      const next = [...current.sectionOrder];
      const target = index + direction;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target], next[index]];
      return { ...current, sectionOrder: next };
    });
  }

  function toggleSection(section: PublicSiteSectionType, next: boolean) {
    setConfiguration((current) => ({
      ...current,
      sectionVisibility: { ...current.sectionVisibility, [section]: next },
    }));
  }

  function sectionSummary(section: PublicSiteSectionType) {
    switch (section) {
      case "introduction":
        return (
          configuration.introductionHeading.trim() ||
          publicSiteSectionDescriptions.introduction
        );
      case "featured_speakers":
        return `${configuration.featuredSpeakerIds.length} of 12 chosen`;
      case "featured_sessions":
        return `${configuration.featuredSessionIds.length} of 12 chosen`;
      case "statistics":
        return shownStatistics.length
          ? shownStatistics
              .map(([statistic]) => publicSiteStatisticLabels[statistic])
              .join(" · ")
          : "No counts shown";
      case "faq":
        return configuration.faqItems.length
          ? `${configuration.faqItems.length} question${
              configuration.faqItems.length === 1 ? "" : "s"
            }`
          : "No questions";
      default:
        return publicSiteSectionDescriptions[section];
    }
  }

  function sectionEditor(section: PublicSiteSectionType) {
    switch (section) {
      case "introduction":
        return (
          <>
            <label className="label">
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
          </>
        );
      case "featured_speakers":
        return (
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
            unavailableMessage={unavailableMessage}
          />
        );
      case "featured_sessions":
        return (
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
            unavailableMessage={unavailableMessage}
          />
        );
      case "statistics":
        return (
          <fieldset className="public-site-selection">
            <legend className="sr-only">Programme statistics</legend>
            <p className="help">
              Counts are read from the published programme when the site is
              rendered.
            </p>
            {statistics.map(([statistic, checked]) => (
              <label className="public-site-inline-check" key={statistic}>
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
                />
                <span>{publicSiteStatisticLabels[statistic]}</span>
              </label>
            ))}
          </fieldset>
        );
      case "venue":
        return (
          <p className="help">
            The venue name, address and map come from Event settings and are not
            edited here. <Link to="/admin/event">Edit event details</Link>.
          </p>
        );
      case "faq":
        return (
          <FaqEditor
            configuration={configuration}
            setConfiguration={setConfiguration}
          />
        );
      default: {
        const unhandledSection: never = section;
        return unhandledSection;
      }
    }
  }

  return (
    <Form method="post" id={formId} className="public-site-draft-form">
      <input type="hidden" name="intent" value="save-site" />
      <input type="hidden" name="commandId" value={commandId} />
      <input type="hidden" name="revision" value={draftRevision} />
      <input
        type="hidden"
        name="configurationJson"
        value={serializedConfiguration}
      />

      <section
        className="public-site-editor-panel"
        aria-label="Homepage and appearance"
        hidden={activePanel !== "homepage"}
      >
        <SitePanelHeading
          title="Site identity and theme"
          help="The tagline and theme apply to every published page."
        />
        <div className="public-site-identity-grid">
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
          <label className="label">
            Theme
            <select
              className="select"
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
        </div>

        <SitePanelHeading
          title="Homepage sections"
          help="Shown sections appear in this order. Open a section to compose it."
        />
        <ol className="public-site-section-order">
          {configuration.sectionOrder.map((section, index) => {
            const visible = configuration.sectionVisibility[section];
            return (
              <HomepageSectionRow
                key={section}
                section={section}
                index={index}
                total={configuration.sectionOrder.length}
                visible={visible}
                disabled={
                  !visible &&
                  ((!programmeAvailable &&
                    PROGRAMME_BACKED_SECTIONS.includes(section)) ||
                    (!programmeReferencesAvailable &&
                      PROGRAMME_REFERENCE_SECTIONS.includes(section)))
                }
                summary={sectionSummary(section)}
                onToggle={(next) => toggleSection(section, next)}
                onMove={(direction) => moveSection(index, direction)}
              >
                {sectionEditor(section)}
              </HomepageSectionRow>
            );
          })}
        </ol>
      </section>

      <section
        className="public-site-editor-panel"
        aria-label="Event pages"
        hidden={activePanel !== "pages"}
      >
        <SitePanelHeading
          title="Event pages"
          help="Five fixed pages, no nesting or arbitrary routes. Only published pages reach the event navigation."
        />
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
      </section>
    </Form>
  );
}
