import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import { Form, Link } from "react-router";
import type { PublishedProgramme } from "~/modules/programme/public-programme-types";
import {
  PUBLIC_SITE_PAGE_TYPES,
  type PublicSiteDraft,
} from "~/modules/public-site/public-site";
import {
  publicSitePageDescriptions,
  publicSiteSectionLabels,
} from "./admin-public-site-constants";

function SiteSectionControls({
  configuration,
  setConfiguration,
}: {
  configuration: PublicSiteDraft;
  setConfiguration: Dispatch<SetStateAction<PublicSiteDraft>>;
}) {
  function move(index: number, direction: -1 | 1) {
    setConfiguration((current) => {
      const next = [...current.sectionOrder];
      const target = index + direction;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target]!, next[index]!];
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
              className="btn small"
              disabled={index === 0}
              onClick={() => move(index, -1)}
            >
              <ChevronUp aria-hidden size={14} /> Move up
            </button>
            <button
              type="button"
              className="btn small"
              disabled={index === configuration.sectionOrder.length - 1}
              onClick={() => move(index, 1)}
            >
              <ChevronDown aria-hidden size={14} /> Move down
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
  unsaved,
  busy,
  saving,
}: {
  configuration: PublicSiteDraft;
  setConfiguration: Dispatch<SetStateAction<PublicSiteDraft>>;
  draftRevision: number;
  serializedConfiguration: string;
  programme: PublishedProgramme | null;
  unsaved: boolean;
  busy: boolean;
  saving: boolean;
}) {
  return (
    <Form method="post" className="card pad">
      <input type="hidden" name="intent" value="save-site" />
      <input type="hidden" name="revision" value={draftRevision} />
      <input
        type="hidden"
        name="configurationJson"
        value={serializedConfiguration}
      />
      <div className="card-title">
        <div>
          <h2>Site identity and theme</h2>
          <p className="help">Draft {draftRevision || "not saved"}</p>
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
          <h2>Homepage sections</h2>
          <p className="help">
            Move buttons are authoritative and keyboard accessible.
          </p>
        </div>
      </div>
      <SiteSectionControls
        configuration={configuration}
        setConfiguration={setConfiguration}
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

      <fieldset className="public-site-selection mt">
        <legend>Featured speakers</legend>
        {programme?.speakers.map((speaker) => (
          <label key={speaker.id}>
            <input
              type="checkbox"
              checked={configuration.featuredSpeakerIds.includes(speaker.id)}
              disabled={
                !configuration.featuredSpeakerIds.includes(speaker.id) &&
                configuration.featuredSpeakerIds.length >= 12
              }
              onChange={(event) =>
                setConfiguration((current) => ({
                  ...current,
                  featuredSpeakerIds: event.target.checked
                    ? [...current.featuredSpeakerIds, speaker.id]
                    : current.featuredSpeakerIds.filter(
                        (id) => id !== speaker.id,
                      ),
                }))
              }
            />{" "}
            {speaker.displayName}
          </label>
        )) ?? (
          <p className="help">Publish a programme before choosing speakers.</p>
        )}
      </fieldset>
      <fieldset className="public-site-selection mt">
        <legend>Featured sessions</legend>
        {programme?.sessions.map((session) => (
          <label key={session.id}>
            <input
              type="checkbox"
              checked={configuration.featuredSessionIds.includes(session.id)}
              disabled={
                !configuration.featuredSessionIds.includes(session.id) &&
                configuration.featuredSessionIds.length >= 12
              }
              onChange={(event) =>
                setConfiguration((current) => ({
                  ...current,
                  featuredSessionIds: event.target.checked
                    ? [...current.featuredSessionIds, session.id]
                    : current.featuredSessionIds.filter(
                        (id) => id !== session.id,
                      ),
                }))
              }
            />{" "}
            {session.title}
          </label>
        )) ?? (
          <p className="help">Publish a programme before choosing sessions.</p>
        )}
      </fieldset>
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

      <div className="card-title mt">
        <div>
          <h2>FAQ</h2>
          <p className="help">
            Answers support paragraphs, headings, lists, bold and HTTPS links.
          </p>
        </div>
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
          </fieldset>
        ))}
      </div>

      <div className="card-title mt">
        <div>
          <h2>Event pages</h2>
          <p className="help">
            Five fixed pages, no nesting or arbitrary routes.
          </p>
        </div>
      </div>
      <div className="public-site-page-editor">
        {PUBLIC_SITE_PAGE_TYPES.map((page) => {
          const value = configuration.pages[page];
          return (
            <fieldset key={page}>
              <legend>{value.title}</legend>
              <label>
                <input
                  type="checkbox"
                  checked={value.enabled}
                  onChange={(event) =>
                    setConfiguration((current) => ({
                      ...current,
                      pages: {
                        ...current.pages,
                        [page]: {
                          ...current.pages[page],
                          enabled: event.target.checked,
                        },
                      },
                    }))
                  }
                />{" "}
                Publish this page with the site
              </label>
              <p className="help">{publicSitePageDescriptions[page]}</p>
              <label className="label">
                Title
                <input
                  className="field"
                  maxLength={100}
                  value={value.title}
                  onChange={(event) =>
                    setConfiguration((current) => ({
                      ...current,
                      pages: {
                        ...current.pages,
                        [page]: {
                          ...current.pages[page],
                          title: event.target.value,
                        },
                      },
                    }))
                  }
                />
              </label>
              <label className="label mt">
                Navigation label
                <input
                  className="field"
                  maxLength={40}
                  value={value.navigationLabel}
                  onChange={(event) =>
                    setConfiguration((current) => ({
                      ...current,
                      pages: {
                        ...current.pages,
                        [page]: {
                          ...current.pages[page],
                          navigationLabel: event.target.value,
                        },
                      },
                    }))
                  }
                />
              </label>
              <label className="label mt">
                Restricted Markdown
                <textarea
                  className="textarea"
                  maxLength={8000}
                  rows={5}
                  value={value.body}
                  onChange={(event) =>
                    setConfiguration((current) => ({
                      ...current,
                      pages: {
                        ...current.pages,
                        [page]: {
                          ...current.pages[page],
                          body: event.target.value,
                        },
                      },
                    }))
                  }
                />
              </label>
            </fieldset>
          );
        })}
      </div>

      <fieldset className="public-site-post-event mt">
        <legend>Post-event mode</legend>
        <label>
          <input
            type="checkbox"
            checked={configuration.postEvent.enabled}
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

      <div className="page-actions mt">
        <button
          className="btn primary"
          type="submit"
          disabled={!unsaved || busy}
        >
          {saving
            ? "Saving…"
            : draftRevision === 0
              ? "Create site draft"
              : "Save site draft"}
        </button>
      </div>
    </Form>
  );
}
