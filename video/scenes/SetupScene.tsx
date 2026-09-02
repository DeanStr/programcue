import {
  AbsoluteFill,
  Img,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

import { ASSETS } from "../assets";

import { PALETTE } from "../constants";
import {
  BrowserWindow,
  between,
  Callout,
  ease,
  enter,
  FocusRing,
  fade,
  GridBackdrop,
  Hairline,
  Kicker,
  PhaseRail,
  type ProductSceneProps,
  rise,
  SegmentLabel,
  sans,
  softEase,
} from "./CommandSetupSceneShared";

function AdminIdentityBadge() {
  return (
    <div
      style={{
        alignItems: "center",
        backgroundColor: "#12211e",
        borderRadius: "0 8px 0 0",
        bottom: 0,
        color: "rgba(255,253,248,.78)",
        display: "flex",
        fontFamily: sans,
        fontSize: 9,
        gap: 7,
        boxSizing: "border-box",
        left: 0,
        padding: "32px 12px 10px",
        position: "absolute",
        width: 160,
        zIndex: 4,
      }}
    >
      <span
        style={{
          backgroundColor: PALETTE.sage,
          borderRadius: "50%",
          height: 6,
          width: 6,
        }}
      />
      Event administrator
    </div>
  );
}

function FlowArrow({
  opacity = 1,
  x,
  y,
}: {
  opacity?: number;
  x: number;
  y: number;
}) {
  return (
    <div
      style={{
        alignItems: "center",
        color: PALETTE.copper,
        display: "flex",
        gap: 8,
        left: x,
        opacity,
        position: "absolute",
        top: y,
        zIndex: 9,
      }}
    >
      <span style={{ backgroundColor: PALETTE.copper, height: 2, width: 34 }} />
      <span
        style={{
          borderBottom: `2px solid ${PALETTE.copper}`,
          borderRight: `2px solid ${PALETTE.copper}`,
          height: 8,
          transform: "rotate(-45deg)",
          width: 8,
        }}
      />
    </div>
  );
}

function PhonePreview({
  frame,
  start,
  opacity = 1,
}: {
  frame: number;
  start: number;
  opacity?: number;
}) {
  const inValue = enter(frame, start, 65);
  const y = rise(frame, start, 46, 65);
  return (
    <div
      style={{
        border: "7px solid #162622",
        borderRadius: 27,
        boxShadow:
          "0 24px 48px rgba(24,37,34,.20), 0 1px 4px rgba(24,37,34,.25)",
        height: 590,
        left: 1510,
        opacity: opacity * inValue,
        overflow: "hidden",
        position: "absolute",
        top: 250,
        transform: `translateY(${y}px) rotate(2deg)`,
        transformOrigin: "center bottom",
        width: 310,
        zIndex: 6,
      }}
    >
      <div
        style={{
          background: PALETTE.ink,
          height: 21,
          left: "50%",
          position: "absolute",
          top: 0,
          transform: "translateX(-50%)",
          width: 92,
          zIndex: 2,
        }}
      />
      <Img
        alt="Mobile published programme preview"
        src={ASSETS.brandingMobile}
        style={{
          display: "block",
          height: "100%",
          objectFit: "cover",
          objectPosition: "top center",
          width: "100%",
        }}
      />
      <div
        style={{
          background:
            "linear-gradient(180deg, transparent 56%, rgba(8,18,16,.28))",
          inset: 0,
          position: "absolute",
        }}
      />
    </div>
  );
}

export function SetupScene({ duration }: ProductSceneProps) {
  const timelineFrame = useCurrentFrame();
  const sourceDuration = 750;
  const frame =
    duration <= 1
      ? sourceDuration - 1
      : (timelineFrame * (sourceDuration - 1)) / (duration - 1);
  const { fps } = useVideoConfig();
  const sceneFade = fade(
    frame,
    -24,
    36,
    Math.max(0, sourceDuration - 80),
    sourceDuration,
  );
  const intro = fade(frame, -24, 36, 372, 420);
  const identity = fade(frame, -18, 34, 310, 344);
  const dataCard = fade(frame, 300, 344, 474, 516);
  const brand = fade(frame, 430, 484, 644, 692);
  const brandWindowY = between(frame, 432, 510, 70, 0, ease);
  const identityWindowScale = between(frame, 0, 340, 0.965, 1.012, softEase);
  const setupX = between(frame, 0, 460, 205, 130, ease);
  const setupWidth = between(frame, 0, 460, 1050, 985, ease);
  const publicIdentityPan =
    between(frame, 70, 110, 0, 1, ease) * between(frame, 184, 212, 1, 0, ease);
  const dataSlide = between(frame, 294, 362, 90, 0, ease);
  const brandSpring = spring({
    fps,
    frame: Math.max(0, frame - 442),
    config: { damping: 17, stiffness: 110, mass: 0.72 },
  });
  const final = fade(frame, 646, 696);

  return (
    <AbsoluteFill
      style={{ color: PALETTE.ink, fontFamily: sans, overflow: "hidden" }}
    >
      <GridBackdrop light />
      <SegmentLabel
        light
        number="04 / 13"
        opacity={sceneFade}
        title="Event setup"
      />
      <PhaseRail
        active={frame > 430 ? 2 : frame > 278 ? 1 : 0}
        light
        opacity={sceneFade}
        phases={["Set the foundation", "Choose the source", "Go public"]}
      />

      <div
        style={{
          left: 80,
          opacity: intro,
          position: "absolute",
          top: 174,
          transform: `translateY(${rise(frame, 12, 26, 62)}px)`,
          width: 480,
          zIndex: 3,
        }}
      >
        <Kicker color={PALETTE.copperDeep}>Event configuration</Kicker>
        <h1
          style={{
            color: PALETTE.ink,
            fontFamily: sans,
            fontSize: 68,
            fontWeight: 760,
            letterSpacing: "-0.07em",
            lineHeight: 0.99,
            margin: "20px 0 0",
            maxWidth: 470,
          }}
        >
          Set the event once.
          <br />
          <span style={{ color: PALETTE.copper }}>Use it everywhere.</span>
        </h1>
        <p
          style={{
            color: PALETTE.muted,
            fontSize: 20,
            lineHeight: 1.46,
            margin: "25px 0 0",
            maxWidth: 430,
          }}
        >
          Define the event foundation once, then reuse it across every
          participant experience.
        </p>
        <div
          style={{
            alignItems: "center",
            color: PALETTE.muted,
            display: "flex",
            fontSize: 12,
            fontWeight: 760,
            gap: 10,
            letterSpacing: "0.1em",
            marginTop: 47,
            textTransform: "uppercase",
          }}
        >
          <span
            style={{
              border: `1px solid ${PALETTE.copper}`,
              borderRadius: "50%",
              height: 18,
              position: "relative",
              width: 18,
            }}
          >
            <span
              style={{
                background: PALETTE.copper,
                borderRadius: "50%",
                height: 5,
                left: 5,
                position: "absolute",
                top: 5,
                width: 5,
              }}
            />
          </span>
          One event foundation
        </div>
      </div>

      <BrowserWindow
        alt="Program Cue event settings identity screen"
        height={670}
        imageTop={-6 - 50 * publicIdentityPan}
        imageWidth={985}
        opacity={identity}
        radius={17}
        src={ASSETS.eventSetup}
        transform={`translate(${setupX}px, ${between(frame, 0, 360, 72, 0, ease)}px) scale(${identityWindowScale})`}
        width={setupWidth}
        x={700}
        y={260}
      >
        <AdminIdentityBadge />
        <FocusRing
          color={PALETTE.sageDeep}
          height={141}
          opacity={
            between(frame, 88, 126, 0, 1, ease) *
            between(frame, 188, 212, 1, 0, ease) *
            identity
          }
          radius={7}
          width={779}
          x={181}
          y={519 - 50 * publicIdentityPan}
        />
      </BrowserWindow>

      <BrowserWindow
        alt="Program Cue event data and retention settings"
        height={650}
        imageTop={-4}
        imageWidth={1015}
        opacity={dataCard}
        radius={17}
        src={ASSETS.eventSetupData}
        transform={`translate(${between(frame, 300, 370, 72, 0, ease)}px, ${between(frame, 300, 380, 48, 0, ease)}px) scale(${between(frame, 300, 410, 0.96, 1, softEase)})`}
        width={1030}
        x={704}
        y={266}
      >
        <AdminIdentityBadge />
        <FocusRing
          color={PALETTE.copper}
          height={295}
          label="Data source & retention"
          opacity={between(frame, 326, 368, 0, 1, ease)}
          radius={9}
          width={485}
          x={510}
          y={250}
        />
      </BrowserWindow>

      <Callout
        body="Set dates, venue, timezone and the public slug before publication."
        color={PALETTE.copper}
        eyebrow="01 / model the event"
        opacity={identity}
        title="Configure public identity."
        transform={`translateY(${rise(frame, 78, 19, 56)}px)`}
        width={365}
        x={90}
        y={730}
        dark={false}
      />
      <div
        style={{
          color: PALETTE.muted,
          fontFamily: sans,
          fontSize: 13,
          left: 90,
          opacity: identity,
          position: "absolute",
          top: 934,
          width: 430,
          zIndex: 4,
        }}
      >
        <Hairline color="#cbd2cb" />
        <div
          style={{
            alignItems: "center",
            display: "flex",
            gap: 9,
            marginTop: 14,
          }}
        >
          <span
            style={{
              background: PALETTE.sageDeep,
              borderRadius: "50%",
              height: 7,
              width: 7,
            }}
          />{" "}
          Participant-facing surfaces reuse these settings.
        </div>
      </div>

      <div
        style={{
          backgroundColor: "rgba(255,255,255,.9)",
          border: "1px solid #d8ddd6",
          borderRadius: 15,
          boxShadow: "0 20px 45px rgba(24,37,34,.12)",
          left: 90,
          opacity: dataCard,
          padding: "20px 22px",
          position: "absolute",
          top: 575,
          transform: `translateY(${dataSlide}px)`,
          width: 460,
          zIndex: 8,
        }}
      >
        <div
          style={{
            alignItems: "center",
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <span style={{ color: PALETTE.ink, fontSize: 16, fontWeight: 760 }}>
            Data and files
          </span>
          <span
            style={{
              alignItems: "center",
              color: PALETTE.copperDeep,
              display: "flex",
              fontSize: 10,
              fontWeight: 800,
              gap: 6,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
            }}
          >
            <span
              style={{
                background: PALETTE.copper,
                borderRadius: "50%",
                height: 6,
                width: 6,
              }}
            />{" "}
            Source selected
          </span>
        </div>
        <div
          style={{
            color: PALETTE.muted,
            fontSize: 13,
            lineHeight: 1.4,
            marginTop: 8,
          }}
        >
          Choose Program Cue or Airtable for event data, with clear file and
          retention policies.
        </div>
        <div style={{ display: "flex", gap: 9, marginTop: 18 }}>
          {["Private files", "Source selected", "24 months"].map(
            (item, index) => (
              <div
                key={item}
                style={{
                  background: index === 1 ? "#f4e4db" : "#f2f4f0",
                  borderRadius: 6,
                  color: index === 1 ? PALETTE.copperDeep : PALETTE.muted,
                  fontSize: 11,
                  fontWeight: 740,
                  padding: "7px 9px",
                }}
              >
                {item}
              </div>
            ),
          )}
        </div>
      </div>
      <AbsoluteFill
        style={{
          background: PALETTE.editorial,
          opacity: brand,
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            background:
              "radial-gradient(circle at 81% 23%, rgba(190,98,66,.12), transparent 35%)",
            inset: 0,
            position: "absolute",
          }}
        />
        <div
          style={{
            left: 95,
            position: "absolute",
            top: 182,
            transform: `translateY(${between(frame, 430, 500, 34, 0, ease)}px)`,
            width: 445,
          }}
        >
          <Kicker color={PALETTE.copperDeep}>Public identity</Kicker>
          <div
            style={{
              color: PALETTE.ink,
              fontFamily: sans,
              fontSize: 59,
              fontWeight: 760,
              letterSpacing: "-0.068em",
              lineHeight: 1.01,
              marginTop: 20,
            }}
          >
            Make every touchpoint
            <br />
            <span style={{ color: PALETTE.copper }}>feel like your event.</span>
          </div>
          <div
            style={{
              color: PALETTE.muted,
              fontSize: 18,
              lineHeight: 1.45,
              marginTop: 22,
              width: 390,
            }}
          >
            Fine-tune in preview. Publish when the experience feels right.
          </div>
        </div>
        <BrowserWindow
          alt="Program Cue branding editor and published programme preview"
          height={680}
          imageTop={brandWindowY - 3}
          imageWidth={1035}
          opacity={brandSpring}
          radius={17}
          src={ASSETS.branding}
          transform={`translateY(${between(frame, 432, 506, 90, 0, ease)}px) scale(${between(frame, 432, 600, 0.95, 1, softEase)})`}
          width={1060}
          x={580}
          y={236}
        >
          <AdminIdentityBadge />
          <FocusRing
            color={PALETTE.copper}
            height={78}
            label="Draft preview"
            opacity={
              between(frame, 496, 545, 0, 1, ease) *
              between(frame, 552, 578, 1, 0, ease)
            }
            radius={7}
            width={515}
            x={500}
            y={165}
          />
          <FocusRing
            color={PALETTE.sageDeep}
            height={42}
            opacity={between(frame, 564, 610, 0, 1, ease)}
            radius={7}
            width={120}
            x={895}
            y={573}
          />
        </BrowserWindow>
        <PhonePreview frame={frame} opacity={brand} start={515} />
        <FlowArrow
          opacity={
            between(frame, 510, 550, 0, 1, ease) *
            between(frame, 552, 578, 1, 0, ease)
          }
          x={1324}
          y={520}
        />
        <div
          style={{
            backgroundColor: "rgba(255,255,255,.93)",
            border: "1px solid #d8ddd6",
            borderRadius: 13,
            bottom: 72,
            boxShadow: "0 14px 34px rgba(24,37,34,.10)",
            left: 95,
            opacity: between(frame, 520, 568, 0, 1, ease),
            padding: "16px 19px",
            position: "absolute",
            width: 416,
            zIndex: 10,
          }}
        >
          <div style={{ alignItems: "center", display: "flex", gap: 10 }}>
            <span
              style={{
                background: PALETTE.sageDeep,
                borderRadius: "50%",
                height: 8,
                width: 8,
              }}
            />
            <span style={{ color: PALETTE.ink, fontSize: 15, fontWeight: 760 }}>
              Draft → preview → publish
            </span>
          </div>
          <div
            style={{
              color: PALETTE.muted,
              fontSize: 12,
              lineHeight: 1.4,
              marginTop: 8,
            }}
          >
            Shape the brand once, then carry it across every public touchpoint.
          </div>
        </div>
        <div
          style={{
            bottom: 72,
            color: PALETTE.muted,
            fontFamily: sans,
            fontSize: 12,
            left: 1550,
            opacity: between(frame, 560, 610, 0, 1, ease),
            position: "absolute",
            width: 278,
            zIndex: 10,
          }}
        >
          <Hairline color="#cbd2cb" />
          <div
            style={{
              alignItems: "center",
              display: "flex",
              gap: 8,
              lineHeight: 1.4,
              marginTop: 12,
            }}
          >
            <span style={{ color: PALETTE.copper, fontSize: 16 }}>↗</span> One
            saved identity flows from preview to the public programme.
          </div>
        </div>
      </AbsoluteFill>

      <AbsoluteFill
        style={{
          background: "linear-gradient(120deg, #12231f, #0d1917)",
          opacity: final,
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            left: 120,
            position: "absolute",
            top: 245,
            transform: `translateY(${between(frame, 632, 704, 28, 0, ease)}px)`,
          }}
        >
          <Kicker>Ready to publish</Kicker>
          <div
            style={{
              color: PALETTE.paper,
              fontFamily: sans,
              fontSize: 67,
              fontWeight: 760,
              letterSpacing: "-0.07em",
              lineHeight: 1,
              marginTop: 23,
            }}
          >
            Reuse event settings
            <br />
            <span style={{ color: PALETTE.copperSoft }}>
              across programme workflows.
            </span>
          </div>
          <div
            style={{
              color: "rgba(255,253,248,.62)",
              fontSize: 20,
              lineHeight: 1.42,
              marginTop: 26,
              maxWidth: 470,
            }}
          >
            Event settings apply across forms, participant workspaces and the
            public programme.
          </div>
        </div>
        <div
          style={{
            border: "1px solid rgba(255,253,248,.14)",
            borderRadius: 18,
            left: 1060,
            opacity: brandSpring,
            padding: 24,
            position: "absolute",
            top: 272,
            transform: `translateY(${(1 - brandSpring) * 30}px)`,
            width: 610,
          }}
        >
          <div style={{ alignItems: "center", display: "flex", gap: 10 }}>
            <span
              style={{
                background: PALETTE.sage,
                borderRadius: "50%",
                height: 8,
                width: 8,
              }}
            />
            <span
              style={{
                color: PALETTE.paper,
                fontSize: 12,
                fontWeight: 800,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
              }}
            >
              Ready to publish
            </span>
          </div>
          <div
            style={{
              color: PALETTE.paper,
              fontSize: 29,
              fontWeight: 730,
              letterSpacing: "-0.04em",
              marginTop: 25,
            }}
          >
            One identity. Every public touchpoint.
          </div>
          <div
            style={{
              color: "rgba(255,253,248,.62)",
              fontSize: 15,
              lineHeight: 1.45,
              marginTop: 9,
            }}
          >
            Review once, then bring the complete event identity to life.
          </div>
          <Hairline />
          <div
            style={{
              alignItems: "center",
              display: "flex",
              justifyContent: "space-between",
              marginTop: 18,
            }}
          >
            <span
              style={{
                color: PALETTE.copperSoft,
                fontSize: 13,
                fontWeight: 760,
              }}
            >
              Continue to application setup
            </span>
            <span style={{ color: "rgba(255,253,248,.58)", fontSize: 20 }}>
              →
            </span>
          </div>
        </div>
        <div
          style={{ bottom: 54, left: 120, position: "absolute", right: 120 }}
        >
          <Hairline />
          <div
            style={{
              color: "rgba(255,253,248,.44)",
              fontSize: 11,
              letterSpacing: "0.12em",
              marginTop: 17,
              textTransform: "uppercase",
            }}
          >
            Program Cue · Event foundations
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}
