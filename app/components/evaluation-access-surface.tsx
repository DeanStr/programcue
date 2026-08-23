import {
  ArrowRight,
  BookOpen,
  Building2,
  CalendarClock,
  CalendarDays,
  Check,
  ClipboardCheck,
  Code,
  Contact,
  Copy,
  Eye,
  EyeOff,
  FileText,
  FolderOpen,
  Gavel,
  Images,
  ListChecks,
  type LucideIcon,
  Mail,
  Megaphone,
  Mic,
  PanelsTopLeft,
  Plus,
  RotateCcw,
  ScanEye,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  UserRound,
  Users,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Form, Link } from "react-router";

import { BrandMark } from "~/components/brand-mark";

export type EvaluationPersonaCard = {
  key: string;
  label: string;
  name: string;
  description: string;
  destination: string;
  whatToTry: string;
  group: "showcase" | "scenario";
  requiresAccountActivation: boolean;
  primaryActionLabel?: string;
  primaryActionHelp?: string;
  secondaryActionLabel?: string;
  progress?: {
    clean: boolean;
    title: string;
    detail: string;
  };
};

export type EvaluationSelection = {
  identityKey: string;
  name: string;
  label: string;
  destination: string;
};

export type EvaluationActionResult = {
  ok: boolean;
  message: string;
  retryAfterSeconds?: number;
};

export type EvaluationAccessSurfaceProps = {
  unlocked: boolean;
  eventName: string;
  selected: EvaluationSelection | null;
  identities: readonly EvaluationPersonaCard[];
  actionData?: EvaluationActionResult;
  busy: boolean;
  resetBusy: boolean;
};

const FIXTURE_REVIEWER_EMAIL = "sam.reviewer@sbek-test.example.com";

const PERSONA_ICONS: Record<string, LucideIcon> = {
  owner: Building2,
  organizer: PanelsTopLeft,
  chair: Gavel,
  reviewer: ScanEye,
  applicant: FileText,
  speaker: Mic,
  sbek_applicant: Sparkles,
  sbek_reviewer: ScanEye,
};

type Destination = {
  to: string;
  icon: LucideIcon;
  label: string;
  detail: string;
};

function retryAfterLabel(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(
      "Evaluation retry-after duration must be a positive finite number.",
    );
  }
  const roundedSeconds = Math.ceil(seconds);
  if (roundedSeconds < 60) {
    return `Try again in about ${roundedSeconds} second${roundedSeconds === 1 ? "" : "s"}.`;
  }
  const minutes = Math.ceil(roundedSeconds / 60);
  return `Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

export const PUBLIC_DESTINATIONS: readonly Destination[] = [
  {
    to: "/public/programme/future-of-events-2027",
    icon: BookOpen,
    label: "Published programme",
    detail: "The live attendee programme.",
  },
  {
    to: "/public/programme/future-of-events-2027/timetable",
    icon: CalendarDays,
    label: "Timetable",
    detail: "Compare published sessions by time and room.",
  },
  {
    to: "/public/programme/future-of-events-2027/schedule",
    icon: CalendarDays,
    label: "Day-by-day schedule",
    detail: "Browse rich chronological session and speaker details.",
  },
  {
    to: "/public/programme/future-of-events-2027/gallery",
    icon: Images,
    label: "Speaker gallery",
    detail: "Published speaker profiles.",
  },
  {
    to: "/apply/form",
    icon: FileText,
    label: "Application form",
    detail: "The open call for proposals.",
  },
  {
    to: "/api/docs",
    icon: Code,
    label: "API documentation",
    detail: "The public programme API reference.",
  },
];

const OPERATIONS_DESTINATIONS: readonly Destination[] = [
  {
    to: "/admin/submissions",
    icon: FileText,
    label: "Applications",
    detail: "Proposal intake and triage.",
  },
  {
    to: "/admin/review",
    icon: ClipboardCheck,
    label: "Review & selection",
    detail: "Rounds, scoring and outcomes.",
  },
  {
    to: "/admin/speakers",
    icon: Users,
    label: "Speakers",
    detail: "Roster, profiles and readiness.",
  },
  {
    to: "/admin/tasks",
    icon: ListChecks,
    label: "Tasks",
    detail: "Assigned operational work.",
  },
  {
    to: "/admin/content",
    icon: FolderOpen,
    label: "Session content & files",
    detail: "Resources, uploads and retention.",
  },
  {
    to: "/admin/schedule",
    icon: CalendarClock,
    label: "Schedule",
    detail: "The planner and its conflicts.",
  },
  {
    to: "/admin/communications",
    icon: Megaphone,
    label: "Communications",
    detail: "Templates and delivery results.",
  },
  {
    to: "/admin/crm",
    icon: Contact,
    label: "Speaker network",
    detail: "Prospects and the invitation pipeline.",
  },
  {
    to: "/admin/events/new",
    icon: Plus,
    label: "Create event",
    detail: "A blank event in the same organisation.",
  },
];

function DestinationLinks({
  destinations,
  label,
}: {
  destinations: readonly Destination[];
  label: string;
}) {
  return (
    <ul aria-label={label} className="pc-eval-links">
      {destinations.map((destination) => {
        const Icon = destination.icon;
        return (
          <li key={destination.to}>
            <Link className="pc-eval-link" to={destination.to}>
              <span className="pc-eval-link-icon">
                <Icon aria-hidden size={17} />
              </span>
              <span>
                <strong>{destination.label}</strong>
                <span>{destination.detail}</span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function PersonaCard({
  identity,
  busy,
  isCurrent,
}: {
  identity: EvaluationPersonaCard;
  busy: boolean;
  isCurrent: boolean;
}) {
  const Icon = PERSONA_ICONS[identity.key] ?? UserRound;
  return (
    <article
      className={`card pad pc-eval-persona${isCurrent ? " is-current" : ""}`}
    >
      <div className="pc-eval-persona-head">
        <span className="pc-eval-persona-icon" data-tone={identity.group}>
          <Icon aria-hidden size={19} />
        </span>
        <div>
          <h3>{identity.label}</h3>
          <p>{identity.name}</p>
        </div>
        {isCurrent ? (
          <span className="status success">Selected persona</span>
        ) : null}
      </div>
      <p className="pc-eval-persona-copy">{identity.description}</p>
      <div className="pc-eval-try">
        <span>What to try</span>
        <p>{identity.whatToTry}</p>
      </div>
      {identity.progress ? (
        <div
          className={`pc-status-notice ${identity.progress.clean ? "is-success" : "is-warning"}`}
        >
          {identity.progress.clean ? (
            <ShieldCheck aria-hidden size={16} />
          ) : (
            <TriangleAlert aria-hidden size={16} />
          )}
          <div className="pc-status-notice-copy">
            <strong>{identity.progress.title}</strong>
            <div>{identity.progress.detail}</div>
          </div>
        </div>
      ) : null}
      <div className="pc-eval-persona-foot">
        <span className="pc-eval-route">
          Opens <code>{identity.destination}</code>
        </span>
        <Form method="post">
          <input
            type="hidden"
            name="_intent"
            value={
              identity.requiresAccountActivation
                ? "activate_account"
                : "select_identity"
            }
          />
          <input type="hidden" name="identity" value={identity.key} />
          <button className="btn primary" disabled={busy} type="submit">
            {identity.primaryActionLabel ??
              (identity.requiresAccountActivation
                ? "Create evaluator submitter account"
                : `Open as ${identity.label}`)}{" "}
            <ArrowRight aria-hidden size={15} />
          </button>
        </Form>
        {identity.requiresAccountActivation ? (
          <>
            <p className="help">
              {identity.primaryActionHelp ??
                "Activates only this fixed fixture identity. No verification email or external-provider delivery is claimed."}
            </p>
            <Form method="post">
              <input
                type="hidden"
                name="_intent"
                value="activate_account_and_choose_event"
              />
              <input type="hidden" name="identity" value={identity.key} />
              <button className="btn" disabled={busy} type="submit">
                {identity.secondaryActionLabel ??
                  "Activate account and choose event"}
              </button>
            </Form>
            <p className="help">
              Opens only events where this fixed identity already has accepted
              access or a pending invitation. Accepting an invitation remains a
              separate explicit step.
            </p>
          </>
        ) : null}
      </div>
    </article>
  );
}

function PersonaCards({
  identities,
  group,
  busy,
  currentKey,
}: {
  identities: readonly EvaluationPersonaCard[];
  group: "showcase" | "scenario";
  busy: boolean;
  currentKey: string | null;
}) {
  return (
    <div
      className={`grid is-equal ${group === "showcase" ? "grid-3" : "grid-2"}`}
    >
      {identities
        .filter((identity) => identity.group === group)
        .map((identity) => (
          <PersonaCard
            busy={busy}
            identity={identity}
            isCurrent={identity.key === currentKey}
            key={identity.key}
          />
        ))}
    </div>
  );
}

function AccessGate({
  actionData,
  busy,
  eventName,
}: {
  actionData?: EvaluationActionResult;
  busy: boolean;
  eventName: string;
}) {
  const [revealed, setRevealed] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (actionData && !actionData.ok) errorRef.current?.focus();
  }, [actionData]);
  return (
    <main className="pc-eval-gate" id="main" tabIndex={-1}>
      <div className="pc-eval-gate-panel">
        <section className="pc-eval-ground pc-eval-gate-intro">
          <div className="pc-eval-brand">
            <BrandMark /> <span>Program Cue</span>
          </div>
          <div>
            <h1>Evaluation access</h1>
            <p className="pc-eval-gate-lede">
              Start here rather than the normal sign-in page. Production sign-in
              is invitation-only, and no evaluator address was pre-invited.
            </p>
          </div>
          <ul className="pc-eval-points">
            <li>
              <ShieldCheck aria-hidden size={18} />
              <span>
                <strong>Fixed personas, real permissions</strong>
                Every persona runs against the same server-side authorisation as
                any other production tenant.
              </span>
            </li>
            <li>
              <CalendarDays aria-hidden size={18} />
              <span>
                <strong>Seeded examples, resettable scenarios</strong>
                Populated showcase roles open on {eventName} data. Scenario
                identities report their current shared-fixture state after the
                gate is unlocked.
              </span>
            </li>
            <li>
              <Mail aria-hidden size={18} />
              <span>
                <strong>No mailbox needed</strong>
                No magic link and no access to a seeded inbox is required to
                start.
              </span>
            </li>
          </ul>
        </section>
        <section className="pc-eval-gate-form">
          <div>
            <h2>Enter the evaluation access code</h2>
            <p className="help pc-eval-gate-hint">
              The code was supplied with your evaluation instructions. It
              unlocks only the fixed identities in the dedicated evaluation
              fixture.
            </p>
          </div>
          {actionData && !actionData.ok ? (
            <div
              className="pc-status-notice is-danger"
              ref={errorRef}
              role="alert"
              tabIndex={-1}
            >
              <TriangleAlert aria-hidden size={18} />
              <div className="pc-status-notice-copy">
                <strong>{actionData.message}</strong>
                {actionData.retryAfterSeconds !== undefined ? (
                  <div>{retryAfterLabel(actionData.retryAfterSeconds)}</div>
                ) : null}
              </div>
            </div>
          ) : null}
          <Form className="stack" method="post">
            <input type="hidden" name="_intent" value="unlock" />
            <label className="label" htmlFor="evaluation-access-code">
              Access code
            </label>
            <div className="pc-eval-code">
              <input
                autoCapitalize="none"
                autoComplete="off"
                autoCorrect="off"
                className="field"
                id="evaluation-access-code"
                name="accessCode"
                required
                spellCheck={false}
                type={revealed ? "text" : "password"}
              />
              <button
                aria-label={revealed ? "Hide access code" : "Show access code"}
                aria-pressed={revealed}
                className="icon-btn"
                onClick={() => setRevealed((value) => !value)}
                type="button"
              >
                {revealed ? (
                  <EyeOff aria-hidden size={16} />
                ) : (
                  <Eye aria-hidden size={16} />
                )}
              </button>
            </div>
            <button className="btn primary" disabled={busy} type="submit">
              {busy ? "Checking…" : "Unlock evaluation"}{" "}
              <ArrowRight aria-hidden size={15} />
            </button>
          </Form>
          <hr className="pc-eval-rule" />
          <div>
            <p className="help pc-eval-gate-hint">
              Public output needs no code:
            </p>
            <ul className="pc-eval-gate-links">
              {PUBLIC_DESTINATIONS.map((destination) => (
                <li key={destination.to}>
                  <Link to={destination.to}>{destination.label}</Link>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </div>
    </main>
  );
}

export function EvaluationAccessSurface({
  unlocked,
  eventName,
  selected,
  identities,
  actionData,
  busy,
  resetBusy,
}: EvaluationAccessSurfaceProps) {
  const [resetConfirmation, setResetConfirmation] = useState("");
  const [reviewerEmailCopyStatus, setReviewerEmailCopyStatus] = useState<
    "idle" | "copied" | "failed"
  >("idle");
  const noticeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (actionData) noticeRef.current?.focus();
    if (actionData?.ok) setResetConfirmation("");
  }, [actionData]);

  const fixtureProgressed = identities.some(
    (identity) =>
      identity.group === "scenario" && identity.progress?.clean === false,
  );

  async function copyFixtureReviewerEmail() {
    if (!navigator.clipboard?.writeText) {
      setReviewerEmailCopyStatus("failed");
      return;
    }
    try {
      await navigator.clipboard.writeText(FIXTURE_REVIEWER_EMAIL);
      setReviewerEmailCopyStatus("copied");
    } catch {
      setReviewerEmailCopyStatus("failed");
    }
  }

  if (!unlocked) {
    return (
      <AccessGate actionData={actionData} busy={busy} eventName={eventName} />
    );
  }

  return (
    <main
      className="design-board pc-design-board pc-eval-board"
      id="main"
      tabIndex={-1}
    >
      <header className="pc-eval-hero">
        <div className="pc-eval-ground pc-eval-hero-top">
          <div className="pc-eval-hero-copy">
            <span className="pc-eval-hero-eyebrow">
              <BrandMark size="small" /> Production evaluation mode
            </span>
            <h1>Choose an evaluation persona</h1>
            <p>
              Each persona opens the real production application with real
              server-side permissions and the seeded data for its role.
              Switching between showcase personas never creates an account and
              never needs a magic link; the scenario applicant has one explicit,
              audited activation step.
            </p>
            <ul className="pc-eval-hero-chips">
              <li>
                <CalendarDays aria-hidden size={13} /> Seeded event: {eventName}
              </li>
              <li>
                <ShieldCheck aria-hidden size={13} /> Production authorisation
                applies
              </li>
            </ul>
          </div>
          <Form className="pc-eval-lock-control" method="post">
            <input type="hidden" name="_intent" value="lock" />
            <button
              aria-describedby="evaluation-lock-help"
              className="btn pc-eval-quiet"
              type="submit"
            >
              <ShieldCheck aria-hidden size={15} /> Lock evaluation
            </button>
            <p id="evaluation-lock-help">
              Requires the access code again on this browser. Shared data is
              unchanged.
            </p>
          </Form>
        </div>
        <div className="pc-eval-hero-session">
          <span aria-hidden className="pc-eval-hero-mark">
            {selected ? selected.name.charAt(0) : <UserRound size={20} />}
          </span>
          <div className="pc-eval-hero-session-copy">
            {selected ? (
              <>
                <strong>
                  Current persona: {selected.label} · {selected.name}
                </strong>
                <p>
                  Private workspaces open with this identity until you choose
                  another persona or lock the evaluation.
                </p>
              </>
            ) : (
              <>
                <strong>No persona selected</strong>
                <p>
                  The access gate is unlocked. Public output is already open
                  below; operations workspaces need a persona first.
                </p>
              </>
            )}
          </div>
          {selected ? (
            <Link className="btn pc-eval-cta" to={selected.destination}>
              Continue as {selected.name} <ArrowRight aria-hidden size={15} />
            </Link>
          ) : null}
        </div>
      </header>

      {actionData ? (
        <div
          className={`pc-status-notice ${actionData.ok ? "is-success" : "is-danger"} mb`}
          ref={noticeRef}
          role={actionData.ok ? "status" : "alert"}
          tabIndex={-1}
        >
          {actionData.ok ? (
            <ShieldCheck aria-hidden size={18} />
          ) : (
            <TriangleAlert aria-hidden size={18} />
          )}
          <div className="pc-status-notice-copy">
            <strong>{actionData.message}</strong>
            {!actionData.ok && actionData.retryAfterSeconds !== undefined ? (
              <div>{retryAfterLabel(actionData.retryAfterSeconds)}</div>
            ) : null}
          </div>
        </div>
      ) : null}

      {fixtureProgressed ? (
        <aside
          aria-label="Evaluation fixture progress"
          className="pc-status-notice is-warning mb"
        >
          <TriangleAlert aria-hidden size={18} />
          <div className="pc-status-notice-copy">
            <strong>Fixture has progressed.</strong>
            <div>
              Continue the current coordinated run with the states shown below.
              Before a separate run, confirm nobody else is evaluating and use{" "}
              <a href="#evaluation-reset">Reset evaluation data</a>. Never reset
              during a chained or overlapping evaluation.
            </div>
          </div>
        </aside>
      ) : null}

      <ol aria-label="How evaluation access works" className="pc-eval-steps mb">
        <li className="is-done">
          <div>
            <strong>Access code entered</strong>
            <span>
              The gate stays unlocked in this browser until you lock it.
            </span>
          </div>
        </li>
        <li className={selected ? "is-done" : undefined}>
          <div>
            <strong>Choose a persona</strong>
            <span>
              Fixed identities only. Each one opens its own seeded work.
            </span>
          </div>
        </li>
        <li>
          <div>
            <strong>Work the role</strong>
            <span>
              Everything you do is production behaviour on the evaluation
              organisation.
            </span>
          </div>
        </li>
        <li>
          <div>
            <strong>Switch or lock</strong>
            <span>
              Return here or use Change persona to switch. Lock evaluation
              clears the gate and asks for the code again.
            </span>
          </div>
        </li>
      </ol>

      <section
        aria-labelledby="reviewer-invitation-paths-title"
        className="card pad mb"
      >
        <div className="pc-admin-section-head">
          <div className="pc-admin-section-head-copy">
            <h2 id="reviewer-invitation-paths-title">Reviewer invitation</h2>
            <p>
              For the repeatable scenario, open as Event organiser and invite
              Sam using this exact address. Return here, select Clean reviewer
              and explicitly accept the pending invitation. You do not need
              access to Sam&apos;s inbox.
            </p>
          </div>
        </div>
        <div className="pc-eval-invitation-email">
          <code>{FIXTURE_REVIEWER_EMAIL}</code>
          <button
            aria-live="polite"
            className="btn small"
            onClick={() => void copyFixtureReviewerEmail()}
            type="button"
          >
            {reviewerEmailCopyStatus === "copied" ? (
              <Check aria-hidden size={14} />
            ) : (
              <Copy aria-hidden size={14} />
            )}{" "}
            {reviewerEmailCopyStatus === "copied" ? "Copied" : "Copy email"}
          </button>
        </div>
        {reviewerEmailCopyStatus === "failed" ? (
          <p className="help" role="alert">
            Copy is unavailable. Select and copy the address instead.
          </p>
        ) : null}
        <details className="pc-disclosure pc-eval-invitation-details mt">
          <summary>Optional: test your own inbox</summary>
          <div className="stack mt">
            <p>
              Invite a fresh email address you control. Before opening its magic
              link in this browser, select Lock evaluation. Open the link, then
              accept the invitation as that email address. Do not select Clean
              reviewer.
            </p>
            <p className="help">
              This creates or reuses a real Program Cue account. Resetting
              evaluation data removes its event access but does not delete the
              account.
            </p>
          </div>
        </details>
      </section>

      <section aria-labelledby="showcase-personas-title" className="mb">
        <div className="pc-admin-section-head">
          <div className="pc-admin-section-head-copy">
            <h2 id="showcase-personas-title">Showcase personas</h2>
            <p>
              Populated roles for exploring the product. Their cards describe
              the reset baseline; because the fixture is shared and mutable,
              later workflow actions can change that seeded work.
            </p>
          </div>
        </div>
        <PersonaCards
          busy={busy}
          currentKey={selected?.identityKey ?? null}
          group="showcase"
          identities={identities}
        />
      </section>

      <section aria-labelledby="scenario-personas-title" className="mb">
        <div className="pc-admin-section-head">
          <div className="pc-admin-section-head-copy">
            <h2 id="scenario-personas-title">
              Automated scenario starting identities
            </h2>
            <p>
              {fixtureProgressed
                ? "Current state in the shared chained scenario. Labels and actions advance with the fixture."
                : "Clean fixture state for a chained human or automated run. These identities have no application, invitation, assignment or review work yet."}
            </p>
          </div>
        </div>
        <PersonaCards
          busy={busy}
          currentKey={selected?.identityKey ?? null}
          group="scenario"
          identities={identities}
        />
      </section>

      <section aria-labelledby="public-output-title" className="mb">
        <div className="pc-admin-section-head">
          <div className="pc-admin-section-head-copy">
            <h2 id="public-output-title">Public output</h2>
            <p>Open to anyone. No persona and no access code required.</p>
          </div>
        </div>
        <DestinationLinks
          destinations={PUBLIC_DESTINATIONS}
          label="Public output"
        />
      </section>

      <section aria-labelledby="operations-title" className="mb">
        <div className="pc-admin-section-head">
          <div className="pc-admin-section-head-copy">
            <h2 id="operations-title">Operations workspaces</h2>
            <p>
              {selected
                ? `Authorisation is enforced on the server, so what opens depends on what ${selected.label} may see.`
                : "Authorisation is enforced on the server rather than by hiding links, so opening one without a persona returns you to this page."}
            </p>
          </div>
        </div>
        <DestinationLinks
          destinations={OPERATIONS_DESTINATIONS}
          label="Operations workspaces"
        />
      </section>

      <aside aria-label="Outbound email" className="pc-status-notice mb">
        <Mail aria-hidden size={18} />
        <div className="pc-status-notice-copy">
          <strong>Outbound email workflows are available to test.</strong>
          <div>
            The fixed evaluator addresses are scenario identities rather than
            inbox credentials, so there is no seeded mailbox to open. A send can
            still fail or bounce, and this page does not verify delivery. For a
            manual delivery test, use an address you control.
          </div>
        </div>
      </aside>

      <details
        className="card pad mb pc-disclosure pc-eval-danger"
        id="evaluation-reset"
      >
        <summary>
          <RotateCcw aria-hidden size={15} />
          <strong>Reset evaluation data</strong>
          <span className="status danger">Destructive</span>
        </summary>
        <div className="mt stack">
          <p>
            Restore the complete dedicated evaluation fixture before starting a
            separate human or automated run. Reset only before a new complete
            run, never between related scenarios.
          </p>
          <ul className="pc-eval-reset-effects">
            <li>Removes evaluator-created event data across the fixture.</li>
            <li>
              Invalidates every evaluator&rsquo;s saved persona session,
              including anyone else currently using this workspace.
            </li>
            <li>
              Returns this browser to the unlocked picker with no persona.
            </li>
          </ul>
          <p className="subtle">
            Reset is refused while fixture events have active external work or
            when the provisioned identities, sender or tenant boundary have
            drifted.
          </p>
          <Form className="stack pc-eval-reset-form" method="post">
            <input type="hidden" name="_intent" value="reset_fixture" />
            <label
              className="label pc-eval-reset-label"
              htmlFor="evaluation-reset-confirmation"
            >
              Type <span className="pc-eval-phrase">{eventName}</span> to
              confirm
            </label>
            <input
              aria-describedby="evaluation-reset-hint"
              autoComplete="off"
              className="field"
              id="evaluation-reset-confirmation"
              name="confirmation"
              onChange={(event) => setResetConfirmation(event.target.value)}
              required
              value={resetConfirmation}
            />
            <p className="help" id="evaluation-reset-hint">
              The reset button stays disabled until the name matches exactly.
            </p>
            <div>
              <button
                className="btn danger"
                disabled={busy || resetConfirmation !== eventName}
                type="submit"
              >
                <RotateCcw aria-hidden size={15} />{" "}
                {resetBusy
                  ? "Resetting evaluation data…"
                  : "Reset evaluation data"}
              </button>
            </div>
          </Form>
        </div>
      </details>
    </main>
  );
}
