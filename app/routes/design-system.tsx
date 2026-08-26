import {
  ArrowRight,
  CalendarDays,
  FileText,
  Search,
  Sparkles,
} from "lucide-react";
import { useState } from "react";
import { BrandMark } from "~/components/brand-mark";
import { AdminWorkspaceTabs } from "~/components/ui/admin-workspace-tabs";
import { Button, ButtonLink } from "~/components/ui/button";
import { ConfirmDialog } from "~/components/ui/confirm-dialog";
import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import { ErrorSummary } from "~/components/ui/error-summary";
import { Field } from "~/components/ui/field";
import { PageHeader } from "~/components/ui/page-header";
import { EmptyState, PendingState } from "~/components/ui/states";
import { StatusBadge } from "~/components/ui/status-badge";
import { StatusNotice } from "~/components/ui/status-notice";
import type { Route } from "./+types/design-system";

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
  const [referencePanel, setReferencePanel] = useState<
    "records" | "schedule" | "delivery"
  >("records");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  return (
    <main id="main" className="design-board pc-design-board" tabIndex={-1}>
      <PageHeader
        eyebrow="Product system · v0.4"
        title="Program Cue design system"
        description="Accessible, operational patterns shared by administrators, reviewers, speakers and applicants. Status always uses words and symbols—not colour alone."
        actions={
          <ButtonLink variant="primary" to="/admin/event">
            Open Event Setup <ArrowRight aria-hidden size={15} />
          </ButtonLink>
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
              Copper carries product actions. Event identity and semantic states
              remain independent.
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
              Eight roles. 12px is the floor — anything smaller was unreadable
              at exactly the moments that mattered most: errors, required marks
              and record metadata.
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
            <Button>Tab to me on white</Button>
            <span className="pc-focus-dark">
              <Button variant="primary">and on a dark ground</Button>
            </span>
          </div>
          <div className="pc-rail-row mt">
            <div
              className="card pad rail-top"
              style={
                { "--rail": "var(--state-bad-solid)" } as React.CSSProperties
              }
            >
              <div className="label">Overdue tasks</div>
              <div className="value" style={{ color: "var(--state-bad-text)" }}>
                12
              </div>
              <small className="subtle">
                The numeral carries the tone; the container stays neutral.
              </small>
            </div>
            <div
              className="card pad rail-top"
              style={
                { "--rail": "var(--state-good-solid)" } as React.CSSProperties
              }
            >
              <div className="label">Sessions published</div>
              <div
                className="value"
                style={{ color: "var(--state-good-text)" }}
              >
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
                  value="Future of Events 2027"
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
              {/* Unavailable is a state a control has to show, not only
                  announce. Read-only recedes to the sunken surface; disabled
                  adds the dashed edge, because the value cannot be focused or
                  copied either. */}
              <Field
                label="Public programme slug"
                description="Frozen while the programme is published. Create the next draft to change it."
              >
                <input
                  className="field"
                  value="future-of-events-2027"
                  disabled
                  readOnly
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
              <span className="pc-section-kicker">Workspace navigation</span>
              <h2>One route, distinct jobs</h2>
            </div>
            <p>
              Pressed-button navigation keeps mounted draft state without
              pretending that one page is several browser destinations.
            </p>
          </div>
          <AdminWorkspaceTabs<"records" | "schedule" | "delivery">
            label="Reference workspace"
            panels={[
              { id: "records", label: "Records", meta: 48 },
              { id: "schedule", label: "Schedule", meta: 3 },
              { id: "delivery", label: "Delivery" },
            ]}
            activePanel={referencePanel}
            onChange={setReferencePanel}
          />
          <section
            className="pc-reference-panel"
            aria-label={`${referencePanel} reference panel`}
          >
            <strong>
              {referencePanel === "records"
                ? "Current programme records"
                : referencePanel === "schedule"
                  ? "Blocking schedule checks"
                  : "Provider delivery evidence"}
            </strong>
            <p>
              {referencePanel === "records"
                ? "Mounted panels preserve unsaved filters and edits while the operator changes jobs."
                : referencePanel === "schedule"
                  ? "Schedule state remains categorical and independent from product emphasis."
                  : "Delivery labels state only the provider evidence that was actually recorded."}
            </p>
          </section>
        </section>

        <section className="card design-section pc-design-wide">
          <div className="pc-section-heading">
            <div>
              <span className="pc-section-kicker">Operational data</span>
              <h2>Rows, status and formats</h2>
            </div>
            <p>
              Repeating records share columns. Lifecycle state and schedule
              category use separate controlled vocabularies.
            </p>
          </div>
          <div className="table-wrap pc-reference-table">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Session</th>
                  <th scope="col">Format</th>
                  <th scope="col">Publication</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">Designing inclusive attendee journeys</th>
                  <td>
                    <span className="pill format">Workshop</span>
                  </td>
                  <td>
                    <DomainStatusBadge domain="session" status="published" />
                  </td>
                </tr>
                <tr>
                  <th scope="row">The future of attendee engagement</th>
                  <td>
                    <span className="pill format">Keynote</span>
                  </td>
                  <td>
                    <DomainStatusBadge domain="session" status="draft" />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section className="card design-section pc-design-wide">
          <div className="pc-section-heading">
            <div>
              <span className="pc-section-kicker">Consequential work</span>
              <h2>Show the blast radius</h2>
            </div>
            <p>
              A confirmation names the material change and affected records,
              then returns focus to the action that opened it.
            </p>
          </div>
          <div className="component-row">
            <Button
              variant="danger"
              onClick={() => {
                setConfirmed(false);
                setConfirmOpen(true);
              }}
            >
              Withdraw programme version
            </Button>
            <span className="help">
              Reference interaction only; it changes no product data.
            </span>
          </div>
          {confirmed ? (
            <StatusNotice
              className="mt"
              tone="success"
              title="Reference confirmation completed"
            >
              No records were changed by this design-system example.
            </StatusNotice>
          ) : null}
          {confirmOpen ? (
            <ConfirmDialog
              title="Withdraw programme version?"
              description="Attendees would stop seeing this published programme."
              records={[
                "Future of Events 2027 · programme version 3",
                "48 published sessions",
              ]}
              confirmLabel="Withdraw version"
              onCancel={() => setConfirmOpen(false)}
              onConfirm={() => {
                setConfirmOpen(false);
                setConfirmed(true);
              }}
            />
          ) : null}
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
