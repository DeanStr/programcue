import {
  AbsoluteFill,
  Img,
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
  FlowRail,
  Footer,
  fade,
  Grain,
  Headline,
  hairline,
  pop,
  RolePill,
  reveal,
  SceneBackdrop,
  type SceneProps,
  type ShotProps,
  Stage,
  type StageProps,
  TopBar,
} from "./CollectDecideSceneShared";

type TimedStageProps = Pick<
  StageProps,
  "start" | "end" | "visibleFrom" | "visibleUntil"
>;

function MetaRow({
  label,
  value,
  accent = PALETTE.paper,
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 24,
        padding: "12px 0",
        borderBottom: `1px solid ${hairline}`,
        ...baseText,
      }}
    >
      <span style={{ color: "rgba(255,255,255,.44)", fontSize: 12 }}>
        {label}
      </span>
      <span
        style={{
          color: accent,
          fontSize: 12,
          fontWeight: 700,
          textAlign: "right",
        }}
      >
        {value}
      </span>
    </div>
  );
}

function InfoCard({
  title,
  body,
  icon,
  accent = PALETTE.copperSoft,
  width = 270,
}: {
  title: string;
  body: string;
  icon: string;
  accent?: string;
  width?: number;
}) {
  return (
    <div
      style={{
        width,
        padding: "17px 18px 18px",
        border: `1px solid ${accent}44`,
        background: "rgba(12, 25, 23, .84)",
        borderRadius: 14,
        boxShadow: "0 16px 30px rgba(0,0,0,.18)",
        ...baseText,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 12,
        }}
      >
        <span
          style={{
            width: 24,
            height: 24,
            borderRadius: 8,
            background: `${accent}18`,
            color: accent,
            display: "grid",
            placeItems: "center",
            fontSize: 13,
            fontWeight: 800,
          }}
        >
          {icon}
        </span>
        <span style={{ fontSize: 13, fontWeight: 800, color: PALETTE.paper }}>
          {title}
        </span>
      </div>
      <div
        style={{
          color: "rgba(255,255,255,.56)",
          fontSize: 12,
          lineHeight: 1.45,
        }}
      >
        {body}
      </div>
    </div>
  );
}

function AdminIdentityOverlay() {
  return (
    <div
      style={{
        alignItems: "center",
        background: "#11201d",
        borderRadius: 7,
        bottom: 42,
        color: "rgba(255,253,248,.8)",
        display: "flex",
        fontSize: 9,
        gap: 7,
        left: 10,
        padding: "7px 9px",
        position: "absolute",
        zIndex: 4,
      }}
    >
      <span
        style={{
          background: PALETTE.sage,
          borderRadius: "50%",
          height: 6,
          width: 6,
        }}
      />
      Event administrator
    </div>
  );
}

function PhoneShot({
  src,
  label,
  x,
  y,
  width,
  height,
  start,
  end,
  objectPosition = "50% 12%",
  holdToEnd = false,
  children,
}: ShotProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const opacity = holdToEnd
    ? reveal(frame, start, 34)
    : fade(frame, start, end, 34);
  const mounted = pop(frame, start + 8, fps);
  const yShift = interpolate(mounted, [0, 1], [46, 0]);
  const rotate = interpolate(mounted, [0, 1], [2.8, -1.2]);

  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width,
        height,
        opacity,
        transform: `translate3d(0, ${yShift}px, 0) rotate(${rotate}deg)`,
        transformOrigin: "50% 90%",
        filter: "drop-shadow(0 30px 32px rgba(0,0,0,.38))",
        ...baseText,
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          padding: 10,
          borderRadius: 35,
          background: "linear-gradient(145deg,#304843,#101918 70%)",
          border: "1px solid rgba(255,255,255,.24)",
          boxShadow: "inset 0 0 0 2px rgba(255,255,255,.05)",
        }}
      >
        <div
          style={{
            position: "relative",
            width: "100%",
            height: "100%",
            overflow: "hidden",
            borderRadius: 27,
            background: "#f5f4ef",
          }}
        >
          <Img
            src={src}
            alt=""
            style={{
              width: "100%",
              height: "100%",
              display: "block",
              objectFit: "cover",
              objectPosition,
            }}
          />
          {children}
          <div
            style={{
              position: "absolute",
              top: 7,
              left: "50%",
              width: 58,
              height: 17,
              borderRadius: 20,
              background: "#111918",
              transform: "translateX(-50%)",
            }}
          />
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: "50%",
          bottom: -30,
          transform: "translateX(-50%)",
          padding: "7px 10px",
          borderRadius: 999,
          background: "rgba(11,20,19,.9)",
          border: "1px solid rgba(255,255,255,.16)",
          color: "rgba(255,255,255,.72)",
          whiteSpace: "nowrap",
          fontSize: 10,
          fontWeight: 800,
          letterSpacing: ".12em",
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>
    </div>
  );
}

function Connector({
  x,
  y,
  width,
  start,
  color = PALETTE.copper,
}: {
  x: number;
  y: number;
  width: number;
  start: number;
  color?: string;
}) {
  const frame = useCurrentFrame();
  const progress = reveal(frame, start, 42);
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: width * progress,
        height: 1,
        background: `linear-gradient(90deg, ${color}, transparent)`,
        transformOrigin: "left center",
      }}
    />
  );
}

function CollectOpening({ start, end, visibleUntil }: TimedStageProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const titleScale = interpolate(pop(frame, start, fps), [0, 1], [0.94, 1]);
  return (
    <Stage start={start} end={end} visibleUntil={visibleUntil}>
      <div style={{ position: "absolute", left: 110, top: 265, ...baseText }}>
        <RolePill label="Programme operations" />
        <div
          style={{
            marginTop: 27,
            transform: `scale(${titleScale})`,
            transformOrigin: "left center",
          }}
        >
          <h1
            style={{
              margin: 0,
              width: 920,
              color: PALETTE.paper,
              fontSize: 94,
              lineHeight: 0.94,
              letterSpacing: "-.08em",
              fontWeight: 740,
            }}
          >
            From application form
            <br />
            to <span style={{ color: PALETTE.copperSoft }}>programme</span>{" "}
            decision.
          </h1>
        </div>
        <p
          style={{
            margin: "33px 0 0",
            color: "rgba(255,255,255,.6)",
            fontSize: 22,
            lineHeight: 1.4,
            maxWidth: 580,
            ...baseText,
          }}
        >
          A traceable workflow from application to decision.
        </p>
      </div>
      <div
        style={{
          position: "absolute",
          right: 160,
          top: 270,
          width: 470,
          height: 470,
          borderRadius: "50%",
          border: `1px solid ${PALETTE.copper}5c`,
          opacity: 0.65,
        }}
      />
      <div
        style={{
          position: "absolute",
          right: 240,
          top: 350,
          width: 310,
          height: 310,
          borderRadius: "50%",
          border: `1px solid ${PALETTE.sage}4d`,
          opacity: 0.65,
        }}
      />
      <div
        style={{
          position: "absolute",
          right: 382,
          top: 492,
          width: 28,
          height: 28,
          borderRadius: "50%",
          background: PALETTE.copper,
          boxShadow: `0 0 0 12px ${PALETTE.copper}1f, 0 0 60px ${PALETTE.copper}`,
        }}
      />
      <div
        style={{
          position: "absolute",
          right: 185,
          top: 320,
          color: "rgba(255,255,255,.36)",
          fontSize: 12,
          letterSpacing: ".13em",
          textTransform: "uppercase",
          ...baseText,
        }}
      >
        collect → decide
      </div>
    </Stage>
  );
}

function CollectBuilder({
  start,
  end,
  visibleFrom,
  visibleUntil,
}: TimedStageProps) {
  return (
    <Stage
      start={start}
      end={end}
      visibleFrom={visibleFrom}
      visibleUntil={visibleUntil}
    >
      <div style={{ position: "absolute", left: 110, top: 188 }}>
        <RolePill label="Admin · form builder" />
        <div style={{ marginTop: 28 }}>
          <Headline
            eyebrow="01 / Build the form"
            title={"Define the\napplication\nquestions."}
            body="Configure sections and conditional fields, then preview the applicant form."
          />
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 12,
            marginTop: 31,
            width: 500,
          }}
        >
          <Check>Build the next version without touching the live form.</Check>
          <Check color={PALETTE.copperSoft}>
            Every question maps to a clear review goal.
          </Check>
        </div>
      </div>
      <BrowserShot
        src={ASSETS.formBuilder}
        label="Admin workspace · form builder"
        caption="Draft v2 · saved"
        x={715}
        y={189}
        width={1110}
        height={685}
        start={start + 15}
        end={end}
        holdToEnd
        objectPosition="50% 50%"
      >
        <AdminIdentityOverlay />
      </BrowserShot>
      <div style={{ position: "absolute", left: 680, top: 908 }}>
        <InfoCard
          title="Version every application with confidence"
          body="Draft the next version while applicants keep using the published form."
          icon="↗"
          width={370}
        />
      </div>
      <Connector x={682} y={837} width={240} start={start + 142} />
    </Stage>
  );
}

function CollectPreview({
  start,
  end,
  visibleFrom,
  visibleUntil,
}: TimedStageProps) {
  return (
    <Stage
      start={start}
      end={end}
      visibleFrom={visibleFrom}
      visibleUntil={visibleUntil}
    >
      <div style={{ position: "absolute", left: 110, top: 188 }}>
        <RolePill label="Admin · preview" color={PALETTE.sage} />
        <div style={{ marginTop: 28 }}>
          <Headline
            eyebrow="02 / Preview the application"
            title={"Review the\napplicant-facing form."}
            body="Preview the applicant-facing form before publishing."
            accent={PALETTE.sage}
          />
        </div>
        <div
          style={{
            marginTop: 34,
            display: "flex",
            flexDirection: "column",
            gap: 12,
            width: 430,
          }}
        >
          <MetaRow label="Surface" value="Public application" />
          <MetaRow label="Experience" value="Applicant journey" />
          <MetaRow label="State" value="Live preview" accent={PALETTE.sage} />
        </div>
      </div>
      <BrowserShot
        src={ASSETS.publicApplication}
        label="Public surface · desktop preview"
        caption="Applicant preview"
        x={690}
        y={164}
        width={1050}
        height={715}
        start={start + 5}
        end={end}
        holdToEnd
        objectPosition="50% 17%"
      />
      <PhoneShot
        src={ASSETS.publicApplicationMobile}
        label="Mobile preview"
        x={1575}
        y={382}
        width={228}
        height={449}
        start={start + 40}
        end={end}
        holdToEnd
        objectPosition="50% 8%"
      >
        <div
          style={{
            position: "absolute",
            right: 13,
            top: 116,
            padding: "6px 8px",
            borderRadius: 6,
            color: PALETTE.paper,
            background: "rgba(11,20,19,.86)",
            fontSize: 9,
            fontWeight: 800,
          }}
        >
          MOBILE READY
        </div>
      </PhoneShot>
      <div
        style={{
          position: "absolute",
          left: 765,
          top: 840,
          display: "flex",
          alignItems: "center",
          gap: 12,
          color: "rgba(255,255,255,.52)",
          fontSize: 12,
          ...baseText,
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: PALETTE.sage,
          }}
        />
        Preview mirrors the applicant-facing route
      </div>
    </Stage>
  );
}

function CollectPublish({
  start,
  end,
  visibleFrom,
  visibleUntil,
}: TimedStageProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pulse = interpolate(Math.sin((frame - start) / 11), [-1, 1], [0.95, 1]);
  const badgeProgress = pop(frame, start + 24, fps);
  return (
    <Stage
      start={start}
      end={end}
      visibleFrom={visibleFrom}
      visibleUntil={visibleUntil}
    >
      <div style={{ position: "absolute", left: 110, top: 190 }}>
        <RolePill label="Admin · publish version" />
        <div style={{ marginTop: 28 }}>
          <Headline
            eyebrow="03 / Publish a version"
            title={"Launch a stable\nform version."}
            body="Applicants submit against the version they opened."
          />
        </div>
        <div
          style={{
            marginTop: 34,
            display: "flex",
            flexDirection: "column",
            gap: 12,
            width: 455,
          }}
        >
          <Check>Draft v2 remains available for the next edit.</Check>
          <Check color={PALETTE.sage}>
            Published v1 is the version under review.
          </Check>
        </div>
      </div>
      <BrowserShot
        src={ASSETS.formBuilderLaptop}
        label="Admin workspace · publish"
        caption="Version history"
        x={720}
        y={214}
        width={1010}
        height={578}
        start={start + 10}
        end={end}
        holdToEnd
        objectPosition="50% 48%"
      >
        <AdminIdentityOverlay />
        <div
          style={{
            position: "absolute",
            right: 22,
            bottom: 18,
            display: "flex",
            gap: 7,
          }}
        >
          <span
            style={{
              padding: "7px 10px",
              borderRadius: 7,
              background: "#fffdf8",
              border: "1px solid #d5d2c8",
              color: "#253631",
              fontSize: 10,
              fontWeight: 800,
            }}
          >
            v2 · Draft
          </span>
          <span
            style={{
              padding: "7px 10px",
              borderRadius: 7,
              background: `${PALETTE.sage}e8`,
              color: "#183421",
              fontSize: 10,
              fontWeight: 800,
            }}
          >
            v1 · Published
          </span>
        </div>
      </BrowserShot>
      <div
        style={{
          position: "absolute",
          left: 1398,
          top: 337,
          width: 266,
          padding: "18px 20px 20px",
          borderRadius: 15,
          background: "rgba(247,245,241,.98)",
          color: PALETTE.ink,
          opacity: badgeProgress,
          transform: `scale(${interpolate(badgeProgress, [0, 1], [0.86, 1])})`,
          boxShadow: "0 22px 52px rgba(0,0,0,.34)",
          ...baseText,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            color: PALETTE.sageDeep,
            fontSize: 12,
            fontWeight: 900,
          }}
        >
          <span
            style={{
              width: 22,
              height: 22,
              borderRadius: "50%",
              display: "grid",
              placeItems: "center",
              background: `${PALETTE.sage}44`,
              color: PALETTE.sageDeep,
            }}
          >
            ✓
          </span>{" "}
          PUBLISHED AND VERSIONED
        </div>
        <div
          style={{
            marginTop: 15,
            fontSize: 25,
            fontWeight: 800,
            letterSpacing: "-.05em",
          }}
        >
          Published version 01
        </div>
        <div
          style={{
            marginTop: 7,
            color: "#65736d",
            fontSize: 11,
            lineHeight: 1.42,
          }}
        >
          Immutable snapshot · ready for applications
        </div>
        <div
          style={{
            marginTop: 17,
            height: 3,
            borderRadius: 3,
            background: PALETTE.sage,
            transform: `scaleX(${pulse})`,
            transformOrigin: "left",
          }}
        />
      </div>
      <Connector
        x={1300}
        y={501}
        width={120}
        start={start + 55}
        color={PALETTE.sage}
      />
    </Stage>
  );
}

function CollectApplicant({
  start,
  end,
  visibleFrom,
  visibleUntil,
}: TimedStageProps) {
  return (
    <Stage
      start={start}
      end={end}
      visibleFrom={visibleFrom}
      visibleUntil={visibleUntil}
    >
      <div style={{ position: "absolute", left: 110, top: 193 }}>
        <RolePill label="Applicant · private draft" color={PALETTE.sage} />
        <div style={{ marginTop: 28 }}>
          <Headline
            eyebrow="04 / Start an application"
            title={"Save and resume\na private draft."}
            body="Email verification controls access to the private draft."
            accent={PALETTE.sage}
          />
        </div>
        <div
          style={{
            marginTop: 33,
            display: "flex",
            flexDirection: "column",
            gap: 13,
            width: 450,
          }}
        >
          <Check color={PALETTE.sage}>
            Draft saved before final submission.
          </Check>
          <Check color={PALETTE.sage}>
            Email verification is required to resume.
          </Check>
          <Check color={PALETTE.copperSoft}>
            This draft stays linked to the form version it started with.
          </Check>
        </div>
      </div>
      <BrowserShot
        src={ASSETS.publicApplication}
        label="Applicant surface · public form"
        caption="Draft saved"
        x={724}
        y={151}
        width={790}
        height={774}
        start={start + 8}
        end={end}
        holdToEnd
        objectPosition="50% 38%"
      />
      <PhoneShot
        src={ASSETS.publicApplicationMobile}
        label="Applicant · verified"
        x={1540}
        y={320}
        width={300}
        height={535}
        start={start + 38}
        end={end}
        holdToEnd
        objectPosition="50% 48%"
      >
        <div
          style={{
            position: "absolute",
            left: 15,
            right: 15,
            top: 222,
            padding: "11px 10px",
            borderRadius: 8,
            background: "rgba(244,252,244,.96)",
            border: `1px solid ${PALETTE.sage}99`,
            color: PALETTE.sageDeep,
            fontSize: 10,
            lineHeight: 1.3,
            fontWeight: 800,
            boxShadow: "0 5px 18px rgba(10,40,25,.16)",
          }}
        >
          ✓ Email verified
          <br />
          <span style={{ fontWeight: 600 }}>
            Your private draft is ready to resume.
          </span>
        </div>
      </PhoneShot>
      <div
        style={{
          position: "absolute",
          left: 730,
          top: 945,
          display: "flex",
          gap: 9,
          ...baseText,
        }}
      >
        <span
          style={{
            padding: "8px 11px",
            borderRadius: 999,
            background: "rgba(143,191,154,.15)",
            border: `1px solid ${PALETTE.sage}55`,
            color: PALETTE.sage,
            fontSize: 11,
            fontWeight: 800,
          }}
        >
          DRAFT SAVED
        </span>
        <span
          style={{
            padding: "8px 11px",
            borderRadius: 999,
            background: "rgba(255,255,255,.06)",
            border: `1px solid ${hairline}`,
            color: "rgba(255,255,255,.58)",
            fontSize: 11,
            fontWeight: 700,
          }}
        >
          6 questions · 12 min
        </span>
      </div>
    </Stage>
  );
}

function CollectSubmit({ start, end, visibleFrom }: TimedStageProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const submitted = pop(frame, start + 96, fps);
  return (
    <Stage start={start} end={end} visibleFrom={visibleFrom}>
      <div style={{ position: "absolute", left: 110, top: 200 }}>
        <RolePill label="Applicant · submission" color={PALETTE.copperSoft} />
        <div style={{ marginTop: 28 }}>
          <Headline
            eyebrow="05 / Submit the application"
            title={"Submission state and\nform version are recorded."}
            body="Reviewers see the submitted answers and form version."
          />
        </div>
        <div
          style={{
            marginTop: 38,
            display: "flex",
            alignItems: "center",
            gap: 14,
            ...baseText,
          }}
        >
          <span
            style={{
              width: 38,
              height: 38,
              borderRadius: "50%",
              display: "grid",
              placeItems: "center",
              background: `${PALETTE.sage}22`,
              border: `1px solid ${PALETTE.sage}77`,
              color: PALETTE.sage,
              fontSize: 18,
            }}
          >
            ✓
          </span>
          <div>
            <div
              style={{ color: PALETTE.paper, fontSize: 14, fontWeight: 800 }}
            >
              Verified submission
            </div>
            <div
              style={{
                color: "rgba(255,255,255,.48)",
                fontSize: 12,
                marginTop: 4,
              }}
            >
              Attached to published version 01
            </div>
          </div>
        </div>
      </div>
      <BrowserShot
        src={ASSETS.publicApplication}
        label="Applicant surface · submitted"
        caption="Submission received · version 01"
        x={746}
        y={177}
        width={910}
        height={696}
        start={start + 6}
        end={end}
        objectPosition="50% 61%"
      >
        <div
          style={{
            position: "absolute",
            left: 36,
            right: 36,
            top: 185,
            padding: "17px 18px",
            borderRadius: 12,
            background: "rgba(247,253,247,.98)",
            border: `1px solid ${PALETTE.sage}aa`,
            color: PALETTE.sageDeep,
            boxShadow: "0 10px 30px rgba(5,30,14,.16)",
            ...baseText,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              fontSize: 14,
              fontWeight: 900,
            }}
          >
            <span
              style={{
                width: 24,
                height: 24,
                display: "grid",
                placeItems: "center",
                borderRadius: "50%",
                background: `${PALETTE.sage}44`,
              }}
            >
              ✓
            </span>{" "}
            Submission received
          </div>
          <div
            style={{
              marginTop: 7,
              marginLeft: 34,
              fontSize: 11,
              color: "#5d7063",
            }}
          >
            Future of Events 2027 · Call for Speakers · v01
          </div>
        </div>
      </BrowserShot>
      <div
        style={{
          position: "absolute",
          right: 150,
          top: 265,
          width: 298,
          padding: 20,
          borderRadius: 15,
          background: "rgba(18,32,30,.94)",
          border: `1px solid ${PALETTE.copper}55`,
          opacity: submitted,
          transform: `translateY(${interpolate(submitted, [0, 1], [24, 0])}px)`,
          ...baseText,
        }}
      >
        <div
          style={{
            color: PALETTE.copperSoft,
            fontSize: 11,
            fontWeight: 900,
            letterSpacing: ".13em",
            textTransform: "uppercase",
          }}
        >
          Ready for review
        </div>
        <div
          style={{
            marginTop: 12,
            color: PALETTE.paper,
            fontSize: 18,
            fontWeight: 800,
            letterSpacing: "-.03em",
          }}
        >
          Reviewers see the
          <br />
          submitted answers and form version.
        </div>
        <div
          style={{
            marginTop: 15,
            color: "rgba(255,255,255,.52)",
            fontSize: 11,
            lineHeight: 1.45,
          }}
        >
          Submission retains its published form version.
        </div>
      </div>
      <Connector
        x={1570}
        y={563}
        width={84}
        start={start + 130}
        color={PALETTE.copperSoft}
      />
    </Stage>
  );
}

export function CollectScene({ duration }: SceneProps) {
  const frame = useCurrentFrame();
  const d = Math.max(1, duration);
  const openingEnd = Math.round(d * 0.15);
  const builderStart = Math.round(d * 0.12);
  const builderEnd = Math.round(d * 0.35);
  const previewStart = Math.round(d * 0.32);
  const previewEnd = Math.round(d * 0.51);
  const publishStart = Math.round(d * 0.47);
  const publishEnd = Math.round(d * 0.66);
  const applicantStart = Math.round(d * 0.63);
  const applicantEnd = Math.round(d * 0.82);
  const submitStart = Math.round(d * 0.79);
  const submitEnd = Math.round(d * 0.93);
  const endStart = Math.round(d * 0.9);
  const builderCut = openingEnd;
  const previewCut = Math.round(d / 3);
  const publishCut = Math.round(d * 0.504);
  const applicantCut = publishEnd;
  const submitCut = applicantEnd;
  const railActive =
    frame < builderCut
      ? 0
      : frame < previewCut
        ? 1
        : frame < publishCut
          ? 2
          : frame < applicantCut
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
      <SceneBackdrop mode="collect" />
      <TopBar
        section="Collect"
        chapter="Versioned application forms"
        step="05 / 13"
      />
      <FlowRail
        items={["Intent", "Build", "Preview", "Publish", "Submit"]}
        active={railActive}
      />
      <CollectOpening start={0} end={openingEnd} visibleUntil={builderCut} />
      <CollectBuilder
        start={builderStart}
        end={builderEnd}
        visibleFrom={builderCut}
        visibleUntil={previewCut}
      />
      <CollectPreview
        start={previewStart}
        end={previewEnd}
        visibleFrom={previewCut}
        visibleUntil={publishCut}
      />
      <CollectPublish
        start={publishStart}
        end={publishEnd}
        visibleFrom={publishCut}
        visibleUntil={applicantCut}
      />
      <CollectApplicant
        start={applicantStart}
        end={applicantEnd}
        visibleFrom={applicantCut}
        visibleUntil={submitCut}
      />
      <CollectSubmit
        start={submitStart}
        end={submitEnd}
        visibleFrom={submitCut}
      />
      <EndCard start={endStart} end={d + 45} mode="collect" />
      <Footer
        label="Collect"
        progress={frame / d}
        right="builder → preview → publish → verified submit"
      />
      <Grain />
    </AbsoluteFill>
  );
}
