import type { CSSProperties } from "react";

import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

import { ASSETS } from "../assets";

import { PALETTE } from "../constants";
import {
  BrowserShot,
  baseText,
  Check,
  EndCard,
  ease,
  FlowRail,
  Footer,
  Grain,
  Headline,
  hairline,
  pop,
  RolePill,
  reveal,
  SceneBackdrop,
  type SceneProps,
  Stage,
  TopBar,
} from "./CollectDecideSceneShared";

function ReviewEvidenceState({
  compact = false,
  showSuggestions = false,
  style,
}: {
  compact?: boolean;
  showSuggestions?: boolean;
  style: CSSProperties;
}) {
  return (
    <div
      style={{
        background: "linear-gradient(135deg, #f7fbf7, #ffffff)",
        border: "1px solid rgba(58,95,66,.24)",
        borderRadius: compact ? 7 : 10,
        boxShadow: "0 8px 22px rgba(24,37,34,.07)",
        boxSizing: "border-box",
        color: PALETTE.ink,
        overflow: "hidden",
        padding: compact ? "8px 10px" : "12px 14px",
        position: "absolute",
        zIndex: 3,
        ...style,
      }}
    >
      <div
        style={{
          color: PALETTE.sageDeep,
          fontSize: compact ? 7 : 10,
          fontWeight: 850,
          letterSpacing: ".08em",
          textTransform: "uppercase",
        }}
      >
        Evidence assistant ready
      </div>
      <div
        style={{
          fontSize: compact ? 8 : 11,
          fontWeight: 760,
          lineHeight: 1.35,
          marginTop: compact ? 5 : 7,
        }}
      >
        Cited suggestions bring the strongest source evidence into focus.
      </div>
      <div
        style={{
          color: PALETTE.sageDeep,
          fontSize: compact ? 7 : 9,
          fontWeight: 760,
          marginTop: compact ? 5 : 7,
        }}
      >
        Source linked · reviewer decides
      </div>
      {showSuggestions ? (
        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          {["Audience relevance · 4", "Practical value · 5"].map((item) => (
            <span
              key={item}
              style={{
                background: "rgba(143,191,154,.13)",
                border: "1px solid rgba(58,95,66,.18)",
                borderRadius: 999,
                color: PALETTE.sageDeep,
                fontSize: 8,
                fontWeight: 760,
                padding: "4px 7px",
              }}
            >
              {item}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DecideOpening({ start, end }: { start: number; end: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = pop(frame, start, fps);
  return (
    <Stage start={start} end={end}>
      <div
        style={{
          position: "absolute",
          left: 110,
          top: 273,
          transform: `translateY(${interpolate(p, [0, 1], [24, 0])}px)`,
          ...baseText,
        }}
      >
        <RolePill label="Review & selection" color={PALETTE.sage} />
        <h1
          style={{
            margin: "27px 0 0",
            color: PALETTE.paper,
            fontSize: 94,
            lineHeight: 0.94,
            letterSpacing: "-.08em",
            fontWeight: 740,
          }}
        >
          Choose the programme
          <br />
          <span style={{ color: PALETTE.sage }}>your audience came for.</span>
        </h1>
        <p
          style={{
            margin: "33px 0 0",
            color: "rgba(255,255,255,.6)",
            fontSize: 22,
            lineHeight: 1.4,
            maxWidth: 620,
          }}
        >
          See every proposal, compare it with one shared rubric and make the
          final call with confidence.
        </p>
      </div>
      <div
        style={{
          position: "absolute",
          right: 173,
          top: 230,
          width: 495,
          height: 495,
          borderRadius: "50%",
          border: `1px solid ${PALETTE.sage}55`,
        }}
      />
      <div
        style={{
          position: "absolute",
          right: 255,
          top: 310,
          width: 335,
          height: 335,
          borderRadius: "50%",
          border: `1px solid ${PALETTE.copper}4d`,
        }}
      />
      <div
        style={{
          position: "absolute",
          right: 405,
          top: 459,
          width: 38,
          height: 38,
          borderRadius: "50%",
          background: PALETTE.sage,
          boxShadow: `0 0 0 13px ${PALETTE.sage}1f, 0 0 65px ${PALETTE.sage}`,
        }}
      />
      <div
        style={{
          position: "absolute",
          right: 168,
          top: 720,
          display: "flex",
          gap: 8,
          color: "rgba(255,255,255,.42)",
          fontSize: 11,
          letterSpacing: ".12em",
          textTransform: "uppercase",
          ...baseText,
        }}
      >
        <span style={{ color: PALETTE.sage }}>review</span>
        <span>·</span>
        <span>evidence</span>
        <span>·</span>
        <span>decision</span>
      </div>
    </Stage>
  );
}

function DecideContext({ start, end }: { start: number; end: number }) {
  return (
    <Stage start={start} end={end}>
      <div style={{ position: "absolute", left: 110, top: 187 }}>
        <RolePill label="Evaluator · assigned queue" color={PALETTE.sage} />
        <div style={{ marginTop: 28 }}>
          <Headline
            eyebrow="01 / Start with context"
            title={"Review with the\nfull queue in view."}
            body="The workbench shows the assignment, proposal and conflict check together."
            accent={PALETTE.sage}
          />
        </div>
        <div
          style={{
            marginTop: 36,
            display: "flex",
            flexDirection: "column",
            gap: 11,
            width: 420,
          }}
        >
          <Check color={PALETTE.sage}>
            The reviewer sees the submitted answers and published form version.
          </Check>
          <Check color={PALETTE.sage}>
            Queue state and assignment stay visible.
          </Check>
        </div>
      </div>
      <BrowserShot
        src={ASSETS.reviewWorkbench}
        label="Evaluator workspace · review workbench"
        caption="Assigned · 1 of 2"
        x={692}
        y={156}
        width={1055}
        height={728}
        start={start + 7}
        end={end}
        objectPosition="72% 38%"
      >
        <ReviewEvidenceState
          showSuggestions
          style={{ height: 116, left: 220, top: 188, width: 425 }}
        />
      </BrowserShot>
      <div
        style={{
          position: "absolute",
          left: 782,
          top: 909,
          padding: "9px 12px",
          borderRadius: 9,
          color: PALETTE.sage,
          border: `1px solid ${PALETTE.sage}55`,
          background: `${PALETTE.sage}10`,
          fontSize: 11,
          fontWeight: 800,
          ...baseText,
        }}
      >
        QUEUE CONTEXT · PROPOSAL · CONFLICT CHECK
      </div>
    </Stage>
  );
}

function RubricCard({
  label,
  weight,
  value,
  x,
  y,
  start,
}: {
  label: string;
  weight: string;
  value: number;
  x: number;
  y: number;
  start: number;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = pop(frame, start, fps);
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: 286,
        padding: "15px 16px 16px",
        borderRadius: 13,
        background: "rgba(247,245,241,.98)",
        color: PALETTE.ink,
        opacity: p,
        transform: `translateY(${interpolate(p, [0, 1], [16, 0])}px)`,
        boxShadow: "0 18px 32px rgba(0,0,0,.24)",
        ...baseText,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 10,
          alignItems: "baseline",
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 900 }}>{label}</span>
        <span
          style={{ color: PALETTE.copperDeep, fontSize: 11, fontWeight: 900 }}
        >
          {weight}
        </span>
      </div>
      <div style={{ marginTop: 14, display: "flex", gap: 6 }}>
        {[1, 2, 3, 4, 5].map((item) => (
          <span
            key={item}
            style={{
              width: 31,
              height: 31,
              borderRadius: "50%",
              display: "grid",
              placeItems: "center",
              border: `1px solid ${item === value ? PALETTE.copper : "#d8d6cc"}`,
              background: item === value ? PALETTE.copper : "#fffdf8",
              color: item === value ? "#fff" : PALETTE.ink,
              fontSize: 11,
              fontWeight: 800,
            }}
          >
            {item}
          </span>
        ))}
      </div>
      <div
        style={{
          marginTop: 10,
          display: "flex",
          justifyContent: "space-between",
          color: "#78827c",
          fontSize: 10,
        }}
      >
        <span>Weak</span>
        <span>Strong</span>
      </div>
    </div>
  );
}

function DecideRubric({ start, end }: { start: number; end: number }) {
  const frame = useCurrentFrame();
  const total = interpolate(frame, [start + 80, start + 145], [0, 4.25], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });
  return (
    <Stage start={start} end={end}>
      <div style={{ position: "absolute", left: 110, top: 190 }}>
        <RolePill
          label="Evaluator · reviewer scoring"
          color={PALETTE.copperSoft}
        />
        <div style={{ marginTop: 28 }}>
          <Headline
            eyebrow="02 / Score the proposal"
            title={"Apply the scoring\nrubric."}
            body="Score weighted criteria with reviewer control."
          />
        </div>
        <div
          style={{
            marginTop: 35,
            color: "rgba(255,255,255,.48)",
            fontSize: 12,
            lineHeight: 1.5,
            width: 390,
            ...baseText,
          }}
        >
          Criterion scores and weights remain visible alongside the total.
        </div>
      </div>
      <BrowserShot
        src={ASSETS.reviewWorkbench}
        label="Evaluator workspace · weighted rubric"
        caption="Draft score · not submitted"
        x={702}
        y={157}
        width={1034}
        height={727}
        start={start + 8}
        end={end}
        objectPosition="77% 53%"
      />
      <RubricCard
        label="Audience relevance"
        weight="30%"
        value={4}
        x={1034}
        y={267}
        start={start + 35}
      />
      <RubricCard
        label="Content substance"
        weight="25%"
        value={5}
        x={1338}
        y={359}
        start={start + 62}
      />
      <RubricCard
        label="Practical value"
        weight="25%"
        value={4}
        x={1034}
        y={565}
        start={start + 89}
      />
      <RubricCard
        label="Delivery approach"
        weight="20%"
        value={4}
        x={1338}
        y={657}
        start={start + 116}
      />
      <div
        style={{
          position: "absolute",
          left: 1160,
          top: 846,
          width: 390,
          padding: "12px 16px",
          borderRadius: 11,
          background: "rgba(11,20,19,.91)",
          border: `1px solid ${PALETTE.copper}66`,
          color: PALETTE.paper,
          opacity: reveal(frame, start + 146, 30),
          ...baseText,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span style={{ color: "rgba(255,255,255,.56)", fontSize: 11 }}>
            Weighted draft score
          </span>
          <span
            style={{
              color: PALETTE.copperSoft,
              fontSize: 21,
              fontWeight: 800,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {total.toFixed(2)} / 5
          </span>
        </div>
      </div>
    </Stage>
  );
}

function AdvisoryCard({
  x,
  y,
  start,
}: {
  x: number;
  y: number;
  start: number;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = pop(frame, start, fps);
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: 437,
        padding: "19px 20px 18px",
        borderRadius: 15,
        background: "rgba(15,31,28,.96)",
        border: `1px solid ${PALETTE.sage}77`,
        opacity: p,
        transform: `translateY(${interpolate(p, [0, 1], [23, 0])}px)`,
        boxShadow: "0 25px 55px rgba(0,0,0,.38)",
        ...baseText,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          style={{
            width: 27,
            height: 27,
            borderRadius: 8,
            display: "grid",
            placeItems: "center",
            background: `${PALETTE.sage}22`,
            color: PALETTE.sage,
            fontSize: 14,
          }}
        >
          ✦
        </span>
        <span style={{ color: PALETTE.paper, fontSize: 14, fontWeight: 850 }}>
          AI evidence assistant
        </span>
        <span
          style={{
            marginLeft: "auto",
            padding: "5px 8px",
            borderRadius: 999,
            background: `${PALETTE.sage}17`,
            border: `1px solid ${PALETTE.sage}55`,
            color: PALETTE.sage,
            fontSize: 9,
            fontWeight: 900,
            letterSpacing: ".1em",
            textTransform: "uppercase",
          }}
        >
          Evidence-linked suggestions
        </span>
      </div>
      <p
        style={{
          margin: "15px 0 0",
          color: "rgba(255,255,255,.64)",
          fontSize: 12,
          lineHeight: 1.46,
        }}
      >
        Source-linked suggestions bring the strongest evidence into focus.
        Import what matters, then complete the review.
      </p>
      <div style={{ marginTop: 15, display: "flex", flexWrap: "wrap", gap: 7 }}>
        {["Source cited", "Import what matters", "Reviewer decides"].map(
          (item) => (
            <span
              key={item}
              style={{
                padding: "7px 9px",
                borderRadius: 7,
                color: "rgba(255,255,255,.56)",
                background: "rgba(255,255,255,.055)",
                border: `1px solid ${hairline}`,
                fontSize: 10,
                fontWeight: 700,
              }}
            >
              {item}
            </span>
          ),
        )}
      </div>
    </div>
  );
}

function DecideAdvisory({ start, end }: { start: number; end: number }) {
  const frame = useCurrentFrame();
  return (
    <Stage start={start} end={end}>
      <div style={{ position: "absolute", left: 110, top: 188 }}>
        <RolePill label="AI-assisted review" color={PALETTE.sage} />
        <div style={{ marginTop: 28 }}>
          <Headline
            eyebrow="03 / Turn evidence into insight"
            title={"Let AI bring\nthe evidence\ninto focus."}
            body="AI brings cited evidence and suggested values alongside the source. Reviewers choose what matters."
            accent={PALETTE.sage}
          />
        </div>
      </div>
      <BrowserShot
        src={ASSETS.reviewWorkbench}
        label="Evaluator workspace · reviewer suggestions"
        caption="Cited suggestions · your call"
        x={703}
        y={161}
        width={1050}
        height={724}
        start={start + 8}
        end={end}
        objectPosition="50% 51%"
      >
        <ReviewEvidenceState
          style={{ height: 92, left: 232, top: 130, width: 410 }}
        />
        <div
          style={{
            position: "absolute",
            left: 232,
            top: 128,
            width: 410,
            height: 96,
            borderRadius: 15,
            border: `2px solid ${PALETTE.sage}aa`,
            boxShadow: `0 0 0 6px ${PALETTE.sage}16, 0 0 28px ${PALETTE.sage}38`,
          }}
        />
      </BrowserShot>
      <AdvisoryCard x={105} y={650} start={start + 62} />
      <div
        style={{
          position: "absolute",
          left: 784,
          top: 840,
          opacity: reveal(frame, start + 95, 28),
          color: PALETTE.sage,
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: ".09em",
          textTransform: "uppercase",
          ...baseText,
        }}
      >
        Source → cited insight → confident review
      </div>
    </Stage>
  );
}

function SubmitReviewCard({ start }: { start: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = pop(frame, start, fps);
  return (
    <div
      style={{
        position: "absolute",
        left: 1254,
        top: 300,
        width: 382,
        padding: 21,
        borderRadius: 15,
        background: "rgba(247,245,241,.98)",
        color: PALETTE.ink,
        opacity: p,
        transform: `translateY(${interpolate(p, [0, 1], [22, 0])}px)`,
        boxShadow: "0 24px 50px rgba(0,0,0,.32)",
        ...baseText,
      }}
    >
      <div
        style={{
          color: PALETTE.copperDeep,
          fontSize: 10,
          letterSpacing: ".14em",
          textTransform: "uppercase",
          fontWeight: 900,
        }}
      >
        SUBMITTED REVIEW
      </div>
      <div
        style={{
          marginTop: 12,
          color: PALETTE.ink,
          fontSize: 23,
          lineHeight: 1.05,
          letterSpacing: "-.05em",
          fontWeight: 850,
        }}
      >
        Review recorded.
      </div>
      <div
        style={{
          marginTop: 14,
          display: "flex",
          flexDirection: "column",
          gap: 9,
        }}
      >
        {[
          "4 criteria scored",
          "Recommendation · Waitlist",
          "Applicant feedback reviewed",
        ].map((item) => (
          <div
            key={item}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 9,
              color: "#596860",
              fontSize: 11,
              fontWeight: 700,
            }}
          >
            <span style={{ color: PALETTE.sageDeep, fontSize: 14 }}>✓</span>
            {item}
          </div>
        ))}
      </div>
      <div
        style={{
          marginTop: 19,
          display: "flex",
          justifyContent: "flex-end",
        }}
      >
        <span
          style={{
            padding: "9px 13px",
            borderRadius: 8,
            background: PALETTE.sageDeep,
            border: `1px solid ${PALETTE.sageDeep}`,
            color: PALETTE.paper,
            fontSize: 11,
            fontWeight: 850,
          }}
        >
          REVIEW SUBMITTED ✓
        </span>
      </div>
    </div>
  );
}

function DecideSubmit({ start, end }: { start: number; end: number }) {
  return (
    <Stage start={start} end={end}>
      <div style={{ position: "absolute", left: 110, top: 191 }}>
        <RolePill
          label="Evaluator · recommendation"
          color={PALETTE.copperSoft}
        />
        <div style={{ marginTop: 28 }}>
          <Headline
            eyebrow="04 / Make the recommendation"
            title={"Turn every review\ninto a clear\nrecommendation."}
            body="Finish the shared rubric, add useful feedback and send the organiser a confident recommendation."
          />
        </div>
        <div
          style={{
            marginTop: 37,
            display: "flex",
            flexDirection: "column",
            gap: 12,
            width: 415,
          }}
        >
          <Check>Keep conflicts of interest clear.</Check>
          <Check>Share helpful feedback without exposing private notes.</Check>
        </div>
      </div>
      <BrowserShot
        src={ASSETS.reviewWorkbench}
        label="Evaluator workspace · final check"
        x={724}
        y={178}
        width={690}
        height={704}
        start={start + 8}
        end={end}
        objectPosition="76% 55%"
      >
        <ReviewEvidenceState
          compact
          style={{ height: 88, left: 144, top: 178, width: 281 }}
        />
      </BrowserShot>
      <SubmitReviewCard start={start + 56} />
      <div
        style={{
          position: "absolute",
          left: 750,
          top: 837,
          display: "flex",
          alignItems: "center",
          gap: 9,
          color: PALETTE.sage,
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: ".1em",
          textTransform: "uppercase",
          ...baseText,
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: PALETTE.sage,
            boxShadow: `0 0 0 5px ${PALETTE.sage}22`,
          }}
        />{" "}
        The organiser's decision preview now includes this review
      </div>
    </Stage>
  );
}

function DecisionPreviewCard({ start }: { start: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = pop(frame, start, fps);
  return (
    <div
      style={{
        position: "absolute",
        right: 137,
        top: 288,
        width: 375,
        padding: 20,
        borderRadius: 15,
        background: "rgba(11,20,19,.95)",
        border: `1px solid ${PALETTE.copperSoft}77`,
        opacity: p,
        transform: `translateY(${interpolate(p, [0, 1], [24, 0])}px)`,
        boxShadow: "0 24px 54px rgba(0,0,0,.34)",
        ...baseText,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span
          style={{
            color: PALETTE.copperSoft,
            fontSize: 10,
            fontWeight: 900,
            letterSpacing: ".14em",
            textTransform: "uppercase",
          }}
        >
          Released decision
        </span>
        <span
          style={{
            padding: "5px 8px",
            borderRadius: 999,
            background: `${PALETTE.gold}17`,
            border: `1px solid ${PALETTE.gold}55`,
            color: PALETTE.gold,
            fontSize: 9,
            fontWeight: 900,
          }}
        >
          DECISION RELEASED · WAITLISTED
        </span>
      </div>
      <div
        style={{
          marginTop: 16,
          color: PALETTE.paper,
          fontSize: 24,
          fontWeight: 850,
          letterSpacing: "-.05em",
        }}
      >
        Decision state
        <br />
        and review evidence
      </div>
      <div
        style={{
          marginTop: 14,
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 9,
        }}
      >
        <div
          style={{
            padding: "10px 11px",
            borderRadius: 9,
            background: "rgba(255,255,255,.06)",
          }}
        >
          <div style={{ color: "rgba(255,255,255,.42)", fontSize: 10 }}>
            Reviews
          </div>
          <div
            style={{
              marginTop: 4,
              color: PALETTE.paper,
              fontSize: 14,
              fontWeight: 800,
            }}
          >
            2 / 2
          </div>
        </div>
        <div
          style={{
            padding: "10px 11px",
            borderRadius: 9,
            background: "rgba(255,255,255,.06)",
          }}
        >
          <div style={{ color: "rgba(255,255,255,.42)", fontSize: 10 }}>
            Average
          </div>
          <div
            style={{
              marginTop: 4,
              color: PALETTE.sage,
              fontSize: 14,
              fontWeight: 800,
            }}
          >
            3.40 / 5
          </div>
        </div>
      </div>
      <div
        style={{
          marginTop: 16,
          paddingTop: 14,
          borderTop: `1px solid ${hairline}`,
          color: "rgba(255,255,255,.6)",
          fontSize: 11,
          lineHeight: 1.45,
        }}
      >
        Decision released · communication status visible.
      </div>
      <div
        style={{ marginTop: 15, display: "flex", justifyContent: "flex-end" }}
      >
        <span
          style={{
            padding: "8px 11px",
            borderRadius: 8,
            background: PALETTE.copper,
            color: "#fff",
            fontSize: 10,
            fontWeight: 850,
          }}
        >
          Review evidence
        </span>
      </div>
    </div>
  );
}

function DecidePreview({ start, end }: { start: number; end: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = pop(frame, start, fps);
  return (
    <Stage start={start} end={end}>
      <div
        style={{
          position: "absolute",
          left: 110,
          top: 192,
          transform: `translateY(${interpolate(p, [0, 1], [12, 0])}px)`,
        }}
      >
        <RolePill
          label="Admin · review & selection"
          color={PALETTE.copperSoft}
        />
        <div style={{ marginTop: 28 }}>
          <Headline
            eyebrow="05 / Review decision evidence"
            title={"Review decision evidence\nand release status."}
            body="Submitted reviews inform an organiser-approved programme decision."
          />
        </div>
        <div
          style={{
            marginTop: 36,
            display: "flex",
            flexDirection: "column",
            gap: 12,
            width: 445,
          }}
        >
          <Check color={PALETTE.sage}>
            Assignments, review count and discussion state stay visible.
          </Check>
          <Check color={PALETTE.copperSoft}>
            Release links the decision to its tracked communication status.
          </Check>
        </div>
      </div>
      <BrowserShot
        src={ASSETS.evaluationAdmin}
        label="Admin workspace · review & selection"
        caption="2 submissions · 1 decision to review"
        x={694}
        y={157}
        width={1072}
        height={727}
        start={start + 6}
        end={end}
        objectPosition="50% 50%"
      />
      <DecisionPreviewCard start={start + 67} />
      <div
        style={{
          position: "absolute",
          left: 753,
          top: 840,
          display: "flex",
          alignItems: "center",
          gap: 10,
          color: "rgba(255,255,255,.53)",
          fontSize: 11,
          ...baseText,
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: PALETTE.gold,
          }}
        />
        <span>Committee evidence collected</span>
        <span style={{ color: PALETTE.copperSoft }}>→</span>
        <span>Decision released · communication status visible</span>
      </div>
    </Stage>
  );
}

export function DecideScene({ duration }: SceneProps) {
  const frame = useCurrentFrame();
  const d = Math.max(1, duration);
  const openingEnd = Math.round(d * 0.14);
  const contextStart = Math.round(d * 0.11);
  const contextEnd = Math.round(d * 0.32);
  const rubricStart = Math.round(d * 0.29);
  const rubricEnd = Math.round(d * 0.49);
  const advisoryStart = Math.round(d * 0.46);
  const advisoryEnd = Math.round(d * 0.65);
  const submitStart = Math.round(d * 0.62);
  const submitEnd = Math.round(d * 0.81);
  const previewStart = Math.round(d * 0.78);
  const previewEnd = Math.round(d * 0.93);
  const endStart = Math.round(d * 0.9);
  const railActive =
    frame < contextStart
      ? 0
      : frame < rubricStart
        ? 1
        : frame < advisoryStart
          ? 2
          : frame < submitStart
            ? 3
            : 4;

  return (
    <AbsoluteFill
      style={{
        background: PALETTE.inkDeep,
        color: PALETTE.paper,
        overflow: "hidden",
      }}
    >
      <SceneBackdrop mode="decide" />
      <TopBar
        section="Decide"
        chapter="Evidence before release"
        step="06 / 13"
      />
      <FlowRail
        items={["Context", "Rubric", "Advisory", "Submit", "Preview"]}
        active={railActive}
      />
      <DecideOpening start={0} end={openingEnd} />
      <DecideContext start={contextStart} end={contextEnd} />
      <DecideRubric start={rubricStart} end={rubricEnd} />
      <DecideAdvisory start={advisoryStart} end={advisoryEnd} />
      <DecideSubmit start={submitStart} end={submitEnd} />
      <DecidePreview start={previewStart} end={previewEnd} />
      <EndCard start={endStart} end={d + 45} mode="decide" />
      <Footer
        label="Decide"
        progress={frame / d}
        right="context → rubric → advisory → submit → decision preview"
      />
      <Grain />
    </AbsoluteFill>
  );
}
