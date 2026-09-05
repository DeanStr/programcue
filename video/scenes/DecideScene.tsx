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

function ReviewAiBoundaryState({ style }: { style: CSSProperties }) {
  return (
    <div
      style={{
        background: "linear-gradient(135deg, #f7fbf7, #ffffff)",
        border: "1px solid rgba(58,95,66,.24)",
        borderRadius: 10,
        boxShadow: "0 8px 22px rgba(24,37,34,.07)",
        boxSizing: "border-box",
        color: PALETTE.ink,
        overflow: "hidden",
        padding: "12px 14px",
        position: "absolute",
        zIndex: 3,
        ...style,
      }}
    >
      <div
        style={{
          color: PALETTE.sageDeep,
          fontSize: 10,
          fontWeight: 850,
          letterSpacing: ".08em",
          textTransform: "uppercase",
        }}
      >
        Administrator opt-in required
      </div>
      <div
        style={{
          fontSize: 11,
          fontWeight: 760,
          lineHeight: 1.35,
          marginTop: 7,
        }}
      >
        Advisory AI stays unavailable until this event explicitly enables it.
      </div>
      <div
        style={{
          color: PALETTE.sageDeep,
          fontSize: 9,
          fontWeight: 760,
          marginTop: 7,
        }}
      >
        AI suggests · reviewer decides
      </div>
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
          Choose the program
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
      />
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
          When configured · advisory only
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
          Explicit opt-in
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
        Suggestions can cite source evidence and offer closed-criterion values.
        They never submit or change a reviewer&apos;s score.
      </p>
      <div style={{ marginTop: 15, display: "flex", flexWrap: "wrap", gap: 7 }}>
        {["Source cited", "No score changes", "Reviewer decides"].map(
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
        <RolePill label="Optional AI boundary" color={PALETTE.sage} />
        <div style={{ marginTop: 28 }}>
          <Headline
            eyebrow="03 / Keep assistance explicit"
            title={"Use AI only\nwhen the event\nenables it."}
            body="Administrators opt in first. If enabled, suggestions cite source evidence; reviewers still own every score and submission."
            accent={PALETTE.sage}
          />
        </div>
      </div>
      <BrowserShot
        src={ASSETS.reviewWorkbench}
        label="Evaluator workspace · reviewer suggestions"
        caption="Disabled until explicit opt-in"
        x={703}
        y={161}
        width={1050}
        height={724}
        start={start + 8}
        end={end}
        objectPosition="50% 51%"
      >
        <ReviewAiBoundaryState
          style={{ height: 96, left: 232, top: 128, width: 410 }}
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
        Opt in → cite the source → keep the human decision
      </div>
    </Stage>
  );
}

function ReviewReturnFlow({ start }: { start: number }) {
  const frame = useCurrentFrame();
  const local = frame - start;
  const clampMotion = {
    easing: ease,
    extrapolateLeft: "clamp" as const,
    extrapolateRight: "clamp" as const,
  };
  const actionOpacity = interpolate(
    local,
    [12, 28, 55, 64],
    [0, 1, 1, 0],
    clampMotion,
  );
  const dialogOpacity = interpolate(
    local,
    [56, 66, 121, 122],
    [0, 1, 1, 0],
    clampMotion,
  );
  const resultOpacity = local >= 122 ? 1 : 0;
  const pointerOpacity = interpolate(
    local,
    [18, 24, 118, 121],
    [0, 1, 1, 0],
    clampMotion,
  );
  const pointerX = interpolate(
    local,
    [20, 52, 62, 78, 84, 91, 99, 114],
    [930, 405, 405, 520, 520, 520, 520, 770],
    clampMotion,
  );
  const pointerY = interpolate(
    local,
    [20, 52, 62, 78, 84, 91, 99, 114],
    [625, 581, 581, 190, 190, 315, 315, 480],
    clampMotion,
  );
  const cannotReviewPress = interpolate(
    local,
    [50, 54, 59],
    [0, 1, 0],
    clampMotion,
  );
  const reasonPress = interpolate(local, [76, 79, 83], [0, 1, 0], clampMotion);
  const notePress = interpolate(local, [89, 92, 96], [0, 1, 0], clampMotion);
  const returnPress = interpolate(
    local,
    [111, 115, 120],
    [0, 1, 0],
    clampMotion,
  );
  const press = Math.max(
    cannotReviewPress,
    reasonPress,
    notePress,
    returnPress,
  );
  const actionRipple = interpolate(local, [52, 64], [0, 1], clampMotion);
  const returnRipple = interpolate(local, [113, 124], [0, 1], clampMotion);
  const reasonSelected = local >= 81;
  const note = "Unavailable for the remainder of this review cycle.";
  const noteLength = Math.floor(
    interpolate(local, [94, 108], [0, note.length], clampMotion),
  );
  const returning = local >= 116;

  return (
    <BrowserShot
      src={ASSETS.reviewWorkbench}
      label="Evaluator workspace · review actions"
      caption="Explicit return · no review submitted"
      x={704}
      y={157}
      width={1054}
      height={728}
      start={start + 4}
      end={start + 205}
      holdToEnd
      objectPosition="77% 55%"
    >
      <div
        style={{
          background: "rgba(13,24,22,.54)",
          inset: 0,
          opacity: dialogOpacity,
          position: "absolute",
          zIndex: 4,
        }}
      />

      <div
        style={{
          background: "rgba(255,253,248,.985)",
          border: "1px solid rgba(173,70,52,.22)",
          borderRadius: 17,
          bottom: 38,
          boxShadow: "0 24px 58px rgba(24,37,34,.24)",
          color: PALETTE.ink,
          left: 302,
          opacity: actionOpacity,
          padding: "18px 22px 20px",
          position: "absolute",
          width: 718,
          zIndex: 6,
        }}
      >
        <div
          style={{
            alignItems: "center",
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <span
            style={{
              color: "#66736d",
              fontSize: 14,
              fontWeight: 780,
              letterSpacing: ".08em",
              textTransform: "uppercase",
            }}
          >
            Review actions
          </span>
          <span
            style={{
              color: PALETTE.sageDeep,
              fontSize: 15,
              fontWeight: 800,
            }}
          >
            Saved
          </span>
        </div>
        <div
          style={{
            alignItems: "center",
            display: "flex",
            gap: 11,
            justifyContent: "flex-end",
            marginTop: 17,
          }}
        >
          <span
            style={{
              background:
                cannotReviewPress > 0.08 ? "rgba(173,70,52,.1)" : "#fffdf8",
              border: "1.5px solid rgba(173,70,52,.58)",
              borderRadius: 9,
              color: "#a33d32",
              fontSize: 20,
              fontWeight: 820,
              padding: "13px 18px",
              transform: `scale(${1 - cannotReviewPress * 0.035})`,
            }}
          >
            Cannot review
          </span>
          {(
            [
              ["Save draft", false],
              ["Submit review", false],
              ["Submit and open next", true],
            ] as const
          ).map(([label, primary]) => (
            <span
              key={label}
              style={{
                background: primary ? "#c99280" : "#fffdf8",
                border: `1px solid ${primary ? "#c99280" : "#d8d6cf"}`,
                borderRadius: 9,
                color: primary ? "#fff" : "#52605a",
                fontSize: 15,
                fontWeight: 760,
                padding: "14px 15px",
              }}
            >
              {label}
            </span>
          ))}
        </div>
      </div>

      <div
        style={{
          border: "2px solid rgba(173,70,52,.72)",
          borderRadius: "50%",
          height: 38 + actionRipple * 76,
          left: 405 - (38 + actionRipple * 76) / 2,
          opacity: (1 - actionRipple) * actionOpacity,
          position: "absolute",
          top: 581 - (38 + actionRipple * 76) / 2,
          width: 38 + actionRipple * 76,
          zIndex: 8,
        }}
      />

      <div
        style={{
          background: "#fffdf8",
          border: "1px solid rgba(24,37,34,.13)",
          borderRadius: 19,
          boxShadow: "0 34px 90px rgba(0,0,0,.34)",
          color: PALETTE.ink,
          left: 142,
          opacity: dialogOpacity,
          overflow: "hidden",
          position: "absolute",
          top: 30,
          transform: `translateY(${(1 - dialogOpacity) * 16}px) scale(${0.985 + dialogOpacity * 0.015})`,
          width: 770,
          zIndex: 10,
        }}
      >
        <div style={{ padding: "25px 29px 22px" }}>
          <div
            style={{
              alignItems: "flex-start",
              display: "flex",
              gap: 20,
              justifyContent: "space-between",
            }}
          >
            <div>
              <div
                style={{
                  fontSize: 34,
                  fontWeight: 850,
                  letterSpacing: "-.045em",
                  lineHeight: 1.05,
                }}
              >
                Cannot review this assignment
              </div>
              <div
                style={{
                  color: "#65716b",
                  fontSize: 19,
                  lineHeight: 1.35,
                  marginTop: 8,
                }}
              >
                Return the assignment without submitting a review.
              </div>
            </div>
            <span
              style={{
                color: "#7c8781",
                fontSize: 24,
                fontWeight: 500,
                lineHeight: 1,
              }}
            >
              ×
            </span>
          </div>
        </div>
        <div
          style={{
            borderTop: "1px solid #e1ded6",
            padding: "20px 29px 26px",
          }}
        >
          <div style={{ color: "#34423c", fontSize: 17, fontWeight: 820 }}>
            Reason
          </div>
          <div
            style={{
              alignItems: "center",
              background: "#fff",
              border: `1.5px solid ${reasonSelected ? "rgba(58,95,66,.56)" : "#cbc9c2"}`,
              borderRadius: 9,
              color: reasonSelected ? PALETTE.ink : "#7c8781",
              display: "flex",
              fontSize: 18,
              fontWeight: reasonSelected ? 760 : 600,
              justifyContent: "space-between",
              marginTop: 8,
              padding: "13px 15px",
            }}
          >
            <span>{reasonSelected ? "Unavailable" : "Choose a reason"}</span>
            <span style={{ color: "#78837d", fontSize: 14 }}>▾</span>
          </div>

          <div
            style={{
              color: "#34423c",
              fontSize: 17,
              fontWeight: 820,
              marginTop: 17,
            }}
          >
            Private note{" "}
            <span style={{ color: "#7b8680", fontWeight: 650 }}>
              (optional)
            </span>
          </div>
          <div
            style={{
              background: "#fff",
              border: "1.5px solid #cbc9c2",
              borderRadius: 9,
              color: PALETTE.ink,
              fontSize: 17,
              height: 58,
              lineHeight: 1.35,
              marginTop: 8,
              padding: "12px 14px",
            }}
          >
            {note.slice(0, noteLength)}
            {local >= 94 && local < 111 ? (
              <span style={{ color: PALETTE.copperDeep }}>│</span>
            ) : null}
          </div>

          <div
            style={{
              background: "rgba(190,98,66,.075)",
              border: "1px solid rgba(190,98,66,.19)",
              borderRadius: 10,
              color: "#5f6c66",
              fontSize: 16,
              fontWeight: 630,
              lineHeight: 1.38,
              marginTop: 17,
              padding: "12px 14px",
            }}
          >
            This resolves the assignment for your queue but reduces organizer
            coverage. The private note is never shared with the applicant.
          </div>

          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              marginTop: 18,
            }}
          >
            <span
              style={{
                background: returning ? "#91382f" : "#ad4634",
                border: "1px solid #91382f",
                borderRadius: 9,
                color: "#fff",
                fontSize: 19,
                fontWeight: 820,
                padding: "13px 18px",
                transform: `scale(${1 - returnPress * 0.035})`,
              }}
            >
              {returning ? "Returning…" : "Return without review"}
            </span>
          </div>
        </div>
      </div>

      <div
        style={{
          border: "2px solid rgba(246,197,169,.78)",
          borderRadius: "50%",
          height: 40 + returnRipple * 86,
          left: 770 - (40 + returnRipple * 86) / 2,
          opacity: (1 - returnRipple) * dialogOpacity,
          position: "absolute",
          top: 480 - (40 + returnRipple * 86) / 2,
          width: 40 + returnRipple * 86,
          zIndex: 12,
        }}
      />

      <div
        style={{
          background:
            "linear-gradient(145deg, rgba(248,250,246,.99), rgba(255,253,248,.99))",
          border: "1px solid rgba(58,95,66,.27)",
          borderRadius: 20,
          boxShadow: "0 30px 76px rgba(24,37,34,.28)",
          color: PALETTE.ink,
          left: 188,
          opacity: resultOpacity,
          padding: "31px 34px 30px",
          position: "absolute",
          top: 164,
          transform: `translateY(${(1 - resultOpacity) * 18}px)`,
          width: 678,
          zIndex: 9,
        }}
      >
        <div style={{ alignItems: "center", display: "flex", gap: 18 }}>
          <span
            style={{
              background: PALETTE.sageDeep,
              borderRadius: "50%",
              color: PALETTE.paper,
              display: "grid",
              fontSize: 25,
              fontWeight: 900,
              height: 52,
              placeItems: "center",
              width: 52,
            }}
          >
            ✓
          </span>
          <div>
            <div
              style={{
                color: PALETTE.sageDeep,
                fontSize: 14,
                fontWeight: 900,
                letterSpacing: ".1em",
                textTransform: "uppercase",
              }}
            >
              Returned · no review submitted
            </div>
            <div
              style={{
                fontSize: 34,
                fontWeight: 860,
                letterSpacing: "-.05em",
                marginTop: 6,
              }}
            >
              Assignment returned without a review.
            </div>
          </div>
        </div>
        <div
          style={{
            borderTop: "1px solid #dadfd8",
            color: "#596761",
            display: "grid",
            fontSize: 17,
            gap: 11,
            gridTemplateColumns: "1fr 1fr",
            lineHeight: 1.36,
            marginTop: 25,
            paddingTop: 20,
          }}
        >
          <span>
            <strong style={{ color: PALETTE.ink }}>Reason</strong>
            <br />
            Unavailable
          </span>
          <span>
            <strong style={{ color: PALETTE.ink }}>Queue</strong>
            <br />1 assignment remains
          </span>
          <span>
            <strong style={{ color: PALETTE.ink }}>Review</strong>
            <br />
            Nothing submitted
          </span>
          <span>
            <strong style={{ color: PALETTE.ink }}>Private note</strong>
            <br />
            Not shared with applicant
          </span>
        </div>
      </div>

      <div
        style={{
          filter: "drop-shadow(0 8px 12px rgba(0,0,0,.24))",
          left: pointerX,
          opacity: pointerOpacity,
          position: "absolute",
          top: pointerY,
          transform: `translate(-4px, -3px) scale(${1 - press * 0.08})`,
          zIndex: 20,
        }}
      >
        <svg aria-hidden="true" height="38" viewBox="0 0 32 40" width="31">
          <path
            d="M4 2.5v28.4l7.5-6.2 5.4 11.9 6-2.8-5.2-11.4H28L4 2.5Z"
            fill="#fffdf8"
            stroke="#182522"
            strokeLinejoin="round"
            strokeWidth="2.4"
          />
        </svg>
      </div>
    </BrowserShot>
  );
}

function DecideSubmit({ start, end }: { start: number; end: number }) {
  return (
    <Stage start={start} end={end} visibleUntil={end}>
      <div style={{ position: "absolute", left: 110, top: 191 }}>
        <RolePill
          label="Alternate reviewer path · cannot review"
          color={PALETTE.copperSoft}
        />
        <div style={{ marginTop: 28 }}>
          <Headline
            eyebrow="04 / Submit—or return explicitly"
            title={"Complete the review.\nOr return it\nwithout one."}
            body="If a reviewer cannot continue, they choose a reason and return the assignment without submitting their draft."
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
          <Check>No draft score or recommendation is submitted.</Check>
          <Check>The private note is never shared with the applicant.</Check>
        </div>
      </div>
      <ReviewReturnFlow start={start} />
      <div
        style={{
          position: "absolute",
          left: 760,
          top: 911,
          display: "flex",
          alignItems: "center",
          gap: 10,
          color: PALETTE.sage,
          fontSize: 12,
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
        Cannot review → choose a reason → return without review
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
    <Stage start={start} end={end} visibleFrom={start}>
      <div
        style={{
          position: "absolute",
          left: 110,
          top: 192,
          transform: `translateY(${interpolate(p, [0, 1], [12, 0])}px)`,
        }}
      >
        <RolePill
          label="Main review path · authorised organiser"
          color={PALETTE.copperSoft}
        />
        <div style={{ marginTop: 28 }}>
          <Headline
            eyebrow="05 / Review decision evidence"
            title={"Review decision evidence\nand release status."}
            body="Only submitted reviews inform the organiser's program decision; returned drafts stay out."
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
  const submitEnd = Math.round(d * 0.795);
  const previewStart = submitEnd;
  const previewEnd = Math.round(d * 0.93);
  const endStart = Math.round(d * 0.9);
  const railActive =
    frame < rubricStart
      ? 0
      : frame < advisoryStart
        ? 1
        : frame < submitStart
          ? 2
          : frame < previewStart
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
        items={[
          "Context",
          "Rubric",
          "AI boundary",
          "Submit / return",
          "Preview",
        ]}
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
        right="context → rubric → AI boundary → submit or return → decision preview"
      />
      <Grain />
    </AbsoluteFill>
  );
}
