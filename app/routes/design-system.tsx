import {
  ArrowRight,
  CalendarDays,
  FileText,
  Search,
  Sparkles,
} from "lucide-react";
import { Link } from "react-router";

import type { Route } from "./+types/design-system";
import { BrandMark } from "~/components/brand-mark";
import { Button } from "~/components/ui/button";
import { ErrorSummary } from "~/components/ui/error-summary";
import { Field } from "~/components/ui/field";
import { PageHeader } from "~/components/ui/page-header";
import { EmptyState, PendingState } from "~/components/ui/states";
import { StatusBadge } from "~/components/ui/status-badge";
import { StatusNotice } from "~/components/ui/status-notice";

export const meta: Route.MetaFunction = () => [
  { title: "Design System · Program Cue" },
];

/* Rendered from the tokens themselves, not from copies of their values, so
   this page cannot drift from what the product actually uses. */
const SWATCHES = [
  ["Brand", "--brand-600", "Primary actions"],
  ["Ink", "--ink", "Core content"],
  ["Canvas", "--canvas", "Work surfaces"],
  ["Success", "--state-good-solid", "Completed work"],
  ["Warning", "--state-warn-solid", "Attention needed"],
  ["Danger", "--state-bad-solid", "Blocking issues"],
] as const;

const TYPE_SCALE = [
  ["--text-3xl", "Page title"],
  ["--text-2xl", "Section title"],
  ["--text-xl", "Card title"],
  ["--text-lg", "Subhead"],
  ["--text-base", "Reading copy"],
  ["--text-sm", "Interface default"],
  ["--text-xs", "Dense data"],
  ["--text-2xs", "Metadata floor"],
] as const;

const SPACE_SCALE = [
  "--space-1",
  "--space-2",
  "--space-3",
  "--space-4",
  "--space-5",
  "--space-6",
  "--space-7",
] as const;

const ELEVATION = [
  ["--elev-1", "Card on canvas"],
  ["--elev-2", "Raised control"],
  ["--elev-3", "Popover, dialog"],
  ["--elev-4", "Dragged object"],
] as const;

export default function DesignSystem() {
  return (
    <main id="main" className="design-board pc-design-board">
      <PageHeader
        eyebrow="Product system · v0.4"
        title="Program Cue design system"
        description="Accessible, operational patterns shared by administrators, reviewers, speakers and applicants. Status always uses words and symbols—not colour alone."
        actions={
          <Link className="btn primary" to="/admin/event">
            Open Event Setup <ArrowRight aria-hidden size={15} />
          </Link>
        }
      />

      <section className="pc-design-hero card">
        <div>
          <StatusBadge tone="info">Interface foundation</StatusBadge>
          <h2>Clarity under pressure</h2>
          <p>
            Dense conference operations stay calm through strong hierarchy,
            explicit state and focused next actions.
          </p>
        </div>
        <div className="pc-design-hero-mark" aria-hidden>
          <BrandMark />
          <span>
            Programme operations,
            <br />
            made explainable.
          </span>
        </div>
      </section>

      <div className="pc-design-grid">
        <section className="card design-section pc-design-wide">
          <div className="pc-section-heading">
            <div>
              <span className="pc-section-kicker">Foundations</span>
              <h2>Colour and hierarchy</h2>
            </div>
            <p>
              Indigo carries product actions. Violet is reserved for clearly
              labelled AI assistance.
            </p>
          </div>
          <div className="pc-swatch-grid">
            {SWATCHES.map(([name, token, use]) => (
              <div className="pc-swatch" key={name}>
                <span
                  className="pc-swatch-colour"
                  style={{ background: `var(${token})` }}
                  aria-hidden
                />
                <strong>{name}</strong>
                <small>{use}</small>
                <code>{token}</code>
              </div>
            ))}
          </div>
        </section>

        <section className="card design-section pc-design-wide">
          <div className="pc-section-heading">
            <div>
              <span className="pc-section-kicker">Foundations</span>
              <h2>Type scale</h2>
            </div>
            <p>
              Eight roles. 12px is the floor — anything smaller was unreadable at
              exactly the moments that mattered most: errors, required marks and
              record metadata.
            </p>
          </div>
          <div className="pc-scale-list">
            {TYPE_SCALE.map(([token, use]) => (
              <div className="pc-scale-row" key={token}>
                <span style={{ fontSize: `var(${token})` }}>
                  Programme operations
                </span>
                <code>{token}</code>
                <small>{use}</small>
              </div>
            ))}
          </div>
        </section>

        <section className="card design-section">
          <div className="pc-section-heading">
            <div>
              <span className="pc-section-kicker">Foundations</span>
              <h2>Space</h2>
            </div>
            <p>
              A 4px grid. Ties tighten the space between things and loosen the
              space inside them.
            </p>
          </div>
          <div className="pc-space-list">
            {SPACE_SCALE.map((token) => (
              <div className="pc-space-row" key={token}>
                <span style={{ width: `var(${token})` }} aria-hidden />
                <code>{token}</code>
              </div>
            ))}
          </div>
        </section>

        <section className="card design-section">
          <div className="pc-section-heading">
            <div>
              <span className="pc-section-kicker">Foundations</span>
              <h2>Elevation</h2>
            </div>
            <p>Border contains, tint groups, shadow floats.</p>
          </div>
          <div className="pc-elev-grid">
            {ELEVATION.map(([token, use]) => (
              <div
                className="pc-elev-tile"
                key={token}
                style={{ boxShadow: `var(${token})` }}
              >
                <code>{token}</code>
                <small>{use}</small>
              </div>
            ))}
          </div>
        </section>

        <section className="card design-section pc-design-wide">
          <div className="pc-section-heading">
            <div>
              <span className="pc-section-kicker">Foundations</span>
              <h2>Focus, motion and state</h2>
            </div>
            <p>
              One focus ring works on every ground: a dark ring carries contrast
              on light surfaces, a white halo carries it on dark and saturated
              ones. Both are always painted, so no surface needs its own rule.
            </p>
          </div>
          <div className="pc-focus-row">
            <button className="btn" type="button">
              Tab to me on white
            </button>
            <span className="pc-focus-dark">
              <button className="btn primary" type="button">
                and on indigo
              </button>
            </span>
          </div>
          <div className="pc-rail-row mt">
            <div className="card pad rail-top" style={{ "--rail": "var(--state-bad-solid)" } as React.CSSProperties}>
              <div className="label">Overdue tasks</div>
              <div className="value" style={{ color: "var(--state-bad-text)" }}>
                12
              </div>
              <small className="subtle">
                The numeral carries the tone; the container stays neutral.
              </small>
            </div>
            <div className="card pad rail-top" style={{ "--rail": "var(--state-good-solid)" } as React.CSSProperties}>
              <div className="label">Sessions published</div>
              <div className="value" style={{ color: "var(--state-good-text)" }}>
                48
              </div>
              <small className="subtle">
                The rail never carries meaning a word does not also carry.
              </small>
            </div>
          </div>
        </section>

        <section className="card design-section">
          <div className="pc-section-heading">
            <div>
              <span className="pc-section-kicker">Actions</span>
              <h2>Buttons</h2>
            </div>
          </div>
          <div className="component-row">
            <Button variant="primary">Save changes</Button>
            <Button>Preview</Button>
            <Button variant="ghost">Cancel</Button>
            <Button variant="danger">Delete</Button>
          </div>
          <div className="component-row mt">
            <Button pending pendingLabel="Saving">
              Save
            </Button>
            <Button disabled>Unavailable</Button>
          </div>
          <p className="help mt">
            Pending buttons stay labelled, disabled and expose their busy state
            to assistive technology.
          </p>
        </section>

        <section className="card design-section">
          <div className="pc-section-heading">
            <div>
              <span className="pc-section-kicker">State</span>
              <h2>Status vocabulary</h2>
            </div>
          </div>
          <div className="component-row">
            <StatusBadge tone="success">Published</StatusBadge>
            <StatusBadge tone="warning">Needs attention</StatusBadge>
            <StatusBadge tone="danger">Blocked</StatusBadge>
            <StatusBadge tone="info">In review</StatusBadge>
            <StatusBadge tone="neutral">Draft</StatusBadge>
            <StatusBadge tone="ai">
              <Sparkles aria-hidden size={12} /> AI advisory
            </StatusBadge>
          </div>
          <p className="help mt">
            Use the smallest vocabulary that maps to the underlying lifecycle.
            Never use a green badge to imply provider delivery without evidence.
          </p>
        </section>

        <section className="card design-section pc-design-wide">
          <div className="pc-section-heading">
            <div>
              <span className="pc-section-kicker">Forms</span>
              <h2>Labels, help and validation</h2>
            </div>
            <p>
              Inline errors identify the field; the summary provides a fast
              route back to every problem.
            </p>
          </div>
          <div className="pc-form-example">
            <div className="stack">
              <Field
                label="Event name"
                description="Shown across the administrator and speaker surfaces."
                required
              >
                <input
                  className="field"
                  value="Future of Events 2025"
                  readOnly
                  required
                />
              </Field>
              <Field
                label="Operations email"
                description="Delivery failures and provider alerts are sent here."
                error="Enter a complete email address."
                required
              >
                <input
                  id="example-email"
                  className="field"
                  type="email"
                  value="ops@"
                  readOnly
                  required
                />
              </Field>
            </div>
            <ErrorSummary
              errors={[
                {
                  message: "Enter a complete operations email address.",
                  href: "#example-email",
                },
              ]}
            />
          </div>
        </section>

        <section className="card design-section pc-design-wide">
          <div className="pc-section-heading">
            <div>
              <span className="pc-section-kicker">Feedback</span>
              <h2>Honest system feedback</h2>
            </div>
            <p>
              Inline notices explain the consequence and next step. Validation
              is never toast-only.
            </p>
          </div>
          <div className="stack">
            <StatusNotice tone="success" title="Form version 3 published">
              The public form now serves this immutable version.
            </StatusNotice>
            <StatusNotice tone="warning" title="Unpublished schedule changes">
              Seven changes must be validated before attendees can see them.
            </StatusNotice>
            <StatusNotice
              tone="danger"
              title="Email provider unavailable"
              action={<Button size="small">Review configuration</Button>}
            >
              Nothing was queued or reported as sent.
            </StatusNotice>
          </div>
        </section>

        <section className="card design-section">
          <div className="pc-section-heading">
            <div>
              <span className="pc-section-kicker">Empty state</span>
              <h2>Point to the next action</h2>
            </div>
          </div>
          <EmptyState
            icon={FileText}
            title="No submission forms"
            description="Create the first form, then preview it before publishing."
            action={
              <Button variant="primary" size="small">
                Create form
              </Button>
            }
          />
        </section>

        <section className="card design-section">
          <div className="pc-section-heading">
            <div>
              <span className="pc-section-kicker">Pending state</span>
              <h2>Announce useful progress</h2>
            </div>
          </div>
          <PendingState label="Loading submission queue" />
        </section>

        <section className="card design-section pc-design-wide">
          <div className="pc-section-heading">
            <div>
              <span className="pc-section-kicker">Consequential work</span>
              <h2>Configure → preview → confirm</h2>
            </div>
            <p>
              Publication, delivery and bulk changes use the same understandable
              safety pattern.
            </p>
          </div>
          <ol className="pc-workflow-steps">
            <li>
              <span>1</span>
              <div>
                <strong>Configure</strong>
                <small>Choose scope and settings</small>
              </div>
              <CalendarDays aria-hidden size={18} />
            </li>
            <li>
              <span>2</span>
              <div>
                <strong>Preview</strong>
                <small>Inspect records and blockers</small>
              </div>
              <Search aria-hidden size={18} />
            </li>
            <li>
              <span>3</span>
              <div>
                <strong>Confirm</strong>
                <small>Approve the explicit change</small>
              </div>
              <ArrowRight aria-hidden size={18} />
            </li>
          </ol>
        </section>
      </div>
    </main>
  );
}
