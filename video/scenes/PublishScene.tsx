import type { ReactNode } from "react";

import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  interpolateColors,
  staticFile,
  useCurrentFrame,
} from "remotion";

import { ASSETS } from "../assets";

import { PALETTE } from "../constants";
import {
  AssetWindow,
  after,
  Check,
  Chip,
  clamp,
  copper,
  copperText,
  cut,
  DotGrid,
  deep,
  Eyebrow,
  ease,
  FooterRail,
  frameProgress,
  ink,
  line,
  local,
  Metric,
  MiniAvatar,
  muted,
  paper,
  SceneHeader,
  type SceneProps,
  sage,
} from "./PlacePublishOperateSceneShared";

const canvas = PALETTE.canvas;

function SurfaceBadge({
  children,
  activity = 0,
}: {
  children: ReactNode;
  activity?: number;
}) {
  const active = clamp(activity);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "9px 12px",
        borderRadius: 11,
        border: `1px solid ${interpolateColors(active, [0, 1], ["rgba(24,37,34,.13)", "rgba(190,98,66,.38)"])}`,
        background: interpolateColors(
          active,
          [0, 1],
          ["rgba(255,255,255,.7)", "rgba(190,98,66,.1)"],
        ),
        color: interpolateColors(active, [0, 1], [muted, copperText]),
        fontSize: 10,
        fontWeight: 850,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        transform: `translate3d(0, ${interpolate(active, [0, 1], [0, -2])}px, 0)`,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: 2,
          background: interpolateColors(active, [0, 1], ["#a9b2ae", copper]),
        }}
      />
      {children}
    </div>
  );
}

function PublishScrollRail({
  progress,
  height,
  dark = false,
}: {
  progress: number;
  height: number;
  dark?: boolean;
}) {
  const thumbTravel = Math.max(0, height - 56);
  return (
    <div
      style={{
        position: "absolute",
        right: 13,
        top: 62,
        width: 18,
        height,
        zIndex: 6,
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          position: "absolute",
          right: 1,
          top: 0,
          bottom: 0,
          width: 3,
          borderRadius: 99,
          background: dark ? "rgba(255,253,248,.2)" : "rgba(24,37,34,.14)",
        }}
      />
      <div
        style={{
          position: "absolute",
          right: 0,
          top: 0,
          width: 5,
          height: 56,
          borderRadius: 99,
          background: dark ? sage : copper,
          boxShadow: dark
            ? "0 6px 18px rgba(143,191,154,.42)"
            : "0 6px 18px rgba(190,98,66,.3)",
          transform: `translate3d(0, ${interpolate(progress, [0, 1], [0, thumbTravel])}px, 0)`,
        }}
      />
      <div
        style={{
          position: "absolute",
          right: 8,
          bottom: 0,
          color: dark ? "rgba(255,253,248,.58)" : muted,
          fontSize: 7,
          fontWeight: 900,
          letterSpacing: "0.12em",
          writingMode: "vertical-rl",
        }}
      >
        PUBLIC VIEW
      </div>
    </div>
  );
}

function PublishSurfaceLayer({
  active,
  children,
  left,
  maskDirection = "incoming",
  maskProgress,
  progress,
  top,
  zIndex,
}: {
  active: boolean;
  children: ReactNode;
  left: number;
  maskDirection?: "incoming" | "outgoing";
  maskProgress?: number;
  progress: number;
  top: number;
  zIndex: number;
}) {
  if (!active) {
    return null;
  }

  const entrance = ease(local(progress, 0, 0.075));
  const mask = maskProgress === undefined ? undefined : clamp(maskProgress);
  const maskStarted = mask !== undefined && mask > 0.001;
  const maskSettled = mask !== undefined && mask >= 0.999;
  const maskInFlight = maskStarted && !maskSettled;
  const maskHidden =
    mask !== undefined &&
    ((maskDirection === "incoming" && !maskStarted) ||
      (maskDirection === "outgoing" && maskSettled));
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        zIndex,
        opacity: maskHidden ? 0 : 1,
        clipPath:
          !maskInFlight || mask === undefined
            ? undefined
            : maskDirection === "incoming"
              ? `inset(0 ${interpolate(mask, [0, 1], [100, 0])}% 0 0)`
              : `inset(0 0 0 ${interpolate(mask, [0, 1], [0, 100])}%)`,
      }}
    >
      <div
        style={{
          position: "absolute",
          left,
          top,
          opacity: interpolate(entrance, [0, 1], [0.84, 1]),
          transform: `translate3d(${interpolate(entrance, [0, 1], [12, 0])}px, ${interpolate(entrance, [0, 1], [5, 0])}px, 0)`,
        }}
      >
        {children}
      </div>
    </div>
  );
}

function PublishMap({ progress }: { progress: number }) {
  const surfacePosition = interpolate(progress, [0, 1], [0, 6]);
  const surfaces = [
    "Programme",
    "Timetable",
    "Day by day",
    "Speakers",
    "Itinerary",
    "Embeds",
    "Event site",
  ];
  return (
    <div
      style={{
        width: 590,
        padding: 25,
        borderRadius: 24,
        background: "rgba(255,253,248,.97)",
        border: `1px solid ${line}`,
        color: ink,
        boxShadow: "0 28px 90px rgba(0,0,0,.24)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 19,
        }}
      >
        <div>
          <div
            style={{ fontSize: 21, fontWeight: 850, letterSpacing: "-0.04em" }}
          >
            Published programme data
          </div>
          <div style={{ color: muted, fontSize: 11, marginTop: 4 }}>
            Seven public views draw on the published programme; the event site
            adds separately published content.
          </div>
        </div>
        <Chip tone="good">7 PUBLIC VIEWS</Chip>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 9 }}>
        {surfaces.map((surface, index) => (
          <SurfaceBadge
            key={surface}
            activity={clamp(1 - Math.abs(index - surfacePosition))}
          >
            {surface}
          </SurfaceBadge>
        ))}
      </div>
      <div
        style={{
          position: "relative",
          height: 195,
          marginTop: 22,
          borderRadius: 16,
          background: "#f1f2ec",
          overflow: "hidden",
          border: `1px solid ${line}`,
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 38,
            right: 38,
            top: 98,
            height: 1,
            background: "rgba(24,37,34,.2)",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 38,
            width: "calc(100% - 76px)",
            top: 97,
            height: 3,
            borderRadius: 99,
            background:
              "linear-gradient(90deg, rgba(190,98,66,.88), rgba(143,191,154,.9))",
            transform: `scaleX(${progress})`,
            transformOrigin: "left center",
          }}
        />
        {["01", "02", "03", "04", "05", "06", "07"].map((item, index) => (
          <div key={item}>
            <div
              style={{
                position: "absolute",
                left: `${9 + index * 13.7}%`,
                top: 83,
                display: "grid",
                placeItems: "center",
                gap: 8,
              }}
            >
              <div
                style={{
                  width: 31,
                  height: 31,
                  borderRadius: 10,
                  display: "grid",
                  placeItems: "center",
                  background: interpolateColors(
                    clamp(1 - Math.abs(index - surfacePosition)),
                    [0, 1],
                    [paper, copper],
                  ),
                  color: interpolateColors(
                    clamp(1 - Math.abs(index - surfacePosition)),
                    [0, 1],
                    [ink, paper],
                  ),
                  border: `1px solid ${interpolateColors(
                    clamp(1 - Math.abs(index - surfacePosition)),
                    [0, 1],
                    [line, copper],
                  )}`,
                  fontSize: 10,
                  fontWeight: 900,
                  boxShadow: "0 7px 14px rgba(24,37,34,.1)",
                  transform: `translate3d(0, ${interpolate(
                    clamp(1 - Math.abs(index - surfacePosition)),
                    [0, 1],
                    [0, -5],
                  )}px, 0)`,
                }}
              >
                {item}
              </div>
            </div>
          </div>
        ))}
        <div
          style={{
            position: "absolute",
            top: 25,
            left: 38,
            color: muted,
            fontSize: 9,
            fontWeight: 850,
            letterSpacing: "0.12em",
          }}
        >
          PUBLISHED PROGRAMME DATA
        </div>
        <div
          style={{
            position: "absolute",
            bottom: 24,
            right: 38,
            color: PALETTE.sageDeep,
            fontSize: 10,
            fontWeight: 850,
            letterSpacing: "0.1em",
          }}
        >
          PUBLIC VIEWS FROM PUBLISHED DATA ↗
        </div>
      </div>
    </div>
  );
}

function PublishHero({ progress }: { progress: number }) {
  const adminDrift = interpolate(progress, [0, 1], [-10, 12]);
  const mapDrift = interpolate(progress, [0, 1], [7, -9]);
  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 80, width: 1540 }}
    >
      <div style={{ width: 700 }}>
        <Eyebrow tone="copper">Publish</Eyebrow>
        <div
          style={{
            color: ink,
            fontSize: 84,
            lineHeight: 0.96,
            fontWeight: 880,
            letterSpacing: "-0.08em",
            marginTop: 20,
          }}
        >
          One programme.
          <br />
          <span style={{ color: copper }}>Every public view.</span>
        </div>
        <div
          style={{
            color: muted,
            fontSize: 17,
            lineHeight: 1.5,
            maxWidth: 500,
            marginTop: 25,
          }}
        >
          Programme, timetable, speakers, itineraries and embeds share one
          connected published source.
        </div>
        <div style={{ display: "flex", gap: 28, marginTop: 34 }}>
          <Metric value="07" label="surfaces shown" tone="copper" />
          <Metric value="01" label="published revision" />
          <Metric value="VERSIONED" label="public views" tone="sage" />
        </div>
      </div>
      <div
        style={{
          position: "relative",
          transform: `translate3d(${adminDrift}px, ${interpolate(progress, [0, 1], [-4, 5])}px, 0)`,
        }}
      >
        <div
          style={{
            transform: `scale(${interpolate(progress, [0, 1], [1.008, 1.022])})`,
            transformOrigin: "center center",
          }}
        >
          <AssetWindow
            src={ASSETS.programmeAdmin}
            label="PROGRAMME ADMIN"
            caption="programme data"
            width={710}
            height={520}
            objectPosition={`center ${interpolate(progress, [0, 1], [0, 9])}%`}
          />
        </div>
        <div
          style={{
            position: "absolute",
            left: -28,
            bottom: -22,
            transform: `translate3d(${-adminDrift * 0.35}px, ${mapDrift}px, 0)`,
          }}
        >
          <PublishMap progress={progress} />
        </div>
      </div>
    </div>
  );
}

function ProgrammeSurface({ progress }: { progress: number }) {
  const viewportDrift = interpolate(progress, [0, 1], [8, -10]);
  const scrollPosition = interpolate(progress, [0, 1], [0, 12]);
  return (
    <div
      style={{ width: 1640, display: "flex", alignItems: "center", gap: 34 }}
    >
      <div style={{ width: 366 }}>
        <Eyebrow tone="copper">01 · Programme + timetable</Eyebrow>
        <div
          style={{
            color: ink,
            fontSize: 52,
            lineHeight: 1,
            fontWeight: 860,
            letterSpacing: "-0.07em",
            marginTop: 17,
          }}
        >
          Help attendees find
          <br />
          the right session,
          <br />
          fast.
        </div>
        <div
          style={{ color: muted, fontSize: 14, lineHeight: 1.5, marginTop: 19 }}
        >
          The public programme supports session discovery and provides direct
          timetable access.
        </div>
        <div
          style={{ display: "flex", gap: 9, flexWrap: "wrap", marginTop: 23 }}
        >
          <Chip tone="good">responsive</Chip>
          <Chip tone="neutral">searchable</Chip>
          <Chip tone="neutral">accessibility-tested</Chip>
        </div>
      </div>
      <div
        style={{
          width: 1240,
          height: 650,
          position: "relative",
          transform: `translate3d(0, ${viewportDrift}px, 0) scale(${interpolate(
            progress,
            [0, 1],
            [1.004, 1.014],
          )})`,
          transformOrigin: "center center",
        }}
      >
        <AssetWindow
          src={ASSETS.publicProgramme}
          label="PUBLIC PROGRAMME"
          caption="/programme"
          width={1240}
          height={650}
          objectPosition={`center ${scrollPosition}%`}
        />
        <PublishScrollRail progress={progress} height={556} />
      </div>
    </div>
  );
}

function DayByDaySurface({ progress }: { progress: number }) {
  const days = ["THU 20", "FRI 21", "SAT 22"];
  const dayPosition = interpolate(progress, [0, 1], [0, days.length - 1]);
  return (
    <div
      style={{
        width: 1480,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 70,
      }}
    >
      <div style={{ position: "relative", width: 710, height: 670 }}>
        <div
          style={{
            position: "absolute",
            left: 14,
            top: 48,
            width: 274,
            height: 560,
            transform: `translate3d(0, ${interpolate(progress, [0, 1], [13, -11])}px, 0) rotate(-5deg)`,
          }}
        >
          <AssetWindow
            src={ASSETS.publicProgrammeMobile}
            label="MOBILE · DAY VIEW"
            caption="day view"
            width={274}
            height={560}
            objectPosition={`center ${interpolate(progress, [0, 1], [0, 22])}%`}
            radius={24}
          />
        </div>
        <div
          style={{
            position: "absolute",
            right: 4,
            top: 0,
            width: 274,
            height: 600,
            transform: `translate3d(0, ${interpolate(progress, [0, 1], [-10, 14])}px, 0) rotate(4deg)`,
          }}
        >
          <AssetWindow
            src={ASSETS.publicProgrammeMobile}
            label="MOBILE · SCHEDULE"
            caption="schedule view"
            width={274}
            height={600}
            objectPosition={`center ${interpolate(progress, [0, 1], [18, 42])}%`}
            radius={24}
          />
        </div>
        <div
          style={{
            position: "absolute",
            left: 226,
            bottom: 22,
            padding: "11px 15px",
            borderRadius: 13,
            background: ink,
            color: paper,
            fontSize: 10,
            fontWeight: 850,
            letterSpacing: "0.08em",
            boxShadow: "0 15px 34px rgba(24,37,34,.28)",
          }}
        >
          DAY-BY-DAY SCHEDULE
        </div>
      </div>
      <div style={{ width: 545 }}>
        <Eyebrow tone="sage">02 · Day by day</Eyebrow>
        <div
          style={{
            color: ink,
            fontSize: 59,
            lineHeight: 0.98,
            fontWeight: 860,
            letterSpacing: "-0.07em",
            marginTop: 17,
          }}
        >
          Browse sessions
          <br />
          <span style={{ color: PALETTE.sageDeep }}>by day.</span>
        </div>
        <div
          style={{ color: muted, fontSize: 15, lineHeight: 1.5, marginTop: 20 }}
        >
          The day view filters the published programme by date while retaining
          the full timetable.
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 26 }}>
          {days.map((day, index) => (
            <div
              key={day}
              style={{
                padding: "10px 11px",
                borderRadius: 10,
                border: `1px solid ${interpolateColors(
                  clamp(1 - Math.abs(index - dayPosition)),
                  [0, 1],
                  [line, "rgba(190,98,66,.42)"],
                )}`,
                background: interpolateColors(
                  clamp(1 - Math.abs(index - dayPosition)),
                  [0, 1],
                  [paper, "rgba(190,98,66,.08)"],
                ),
                color: interpolateColors(
                  clamp(1 - Math.abs(index - dayPosition)),
                  [0, 1],
                  [muted, copper],
                ),
                fontSize: 9,
                fontWeight: 850,
                letterSpacing: "0.08em",
                transform: `translate3d(0, ${interpolate(
                  clamp(1 - Math.abs(index - dayPosition)),
                  [0, 1],
                  [0, -3],
                )}px, 0)`,
              }}
            >
              {day}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function SpeakersSurface({ progress }: { progress: number }) {
  return (
    <div
      style={{ width: 1380, display: "flex", alignItems: "center", gap: 100 }}
    >
      <div style={{ width: 505 }}>
        <Eyebrow tone="copper">03 · Speakers</Eyebrow>
        <div
          style={{
            color: ink,
            fontSize: 59,
            lineHeight: 0.98,
            fontWeight: 860,
            letterSpacing: "-0.07em",
            marginTop: 17,
          }}
        >
          Publish searchable
          <br />
          <span style={{ color: copper }}>speaker profiles.</span>
        </div>
        <div
          style={{ color: muted, fontSize: 15, lineHeight: 1.5, marginTop: 20 }}
        >
          Speaker profiles link biographies and published sessions.
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 11,
            marginTop: 27,
          }}
        >
          <div
            style={{
              transform: `translate3d(0, ${interpolate(progress, [0, 1], [3, -4])}px, 0)`,
            }}
          >
            <MiniAvatar initials="PS" color="#436b62" />
          </div>
          <div
            style={{
              transform: `translate3d(0, ${interpolate(progress, [0, 1], [-3, 4])}px, 0)`,
            }}
          >
            <MiniAvatar initials="AM" color={copper} />
          </div>
          <span style={{ color: muted, fontSize: 11, fontWeight: 750 }}>
            Linked speaker profiles
          </span>
        </div>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 28,
          position: "relative",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 248,
            top: 300,
            width: 72,
            height: 3,
            zIndex: 0,
            borderRadius: 99,
            background:
              "linear-gradient(90deg, rgba(190,98,66,.14), rgba(190,98,66,.86), rgba(143,191,154,.82))",
            transform: `scaleX(${progress})`,
            transformOrigin: "left center",
          }}
        />
        <div
          style={{
            position: "relative",
            zIndex: 1,
            transform: `translate3d(0, ${interpolate(progress, [0, 1], [12, -13])}px, 0) rotate(${interpolate(progress, [0, 1], [-1.2, 0.8])}deg)`,
          }}
        >
          <AssetWindow
            src={ASSETS.speakerGalleryMobile}
            label="SPEAKER GALLERY"
            caption="/speakers"
            width={270}
            height={600}
            objectPosition={`center ${interpolate(progress, [0, 1], [0, 100])}%`}
            radius={24}
          />
        </div>
        <div
          style={{
            position: "relative",
            zIndex: 1,
            transform: `translate3d(0, ${interpolate(progress, [0, 1], [-12, 13])}px, 0) rotate(${interpolate(progress, [0, 1], [1, -0.9])}deg)`,
          }}
        >
          <AssetWindow
            src={ASSETS.publicProgrammeMobile}
            label="SESSION LINK"
            caption="linked"
            width={270}
            height={600}
            objectPosition={`center ${interpolate(progress, [0, 1], [46, 66])}%`}
            radius={24}
          />
        </div>
      </div>
    </div>
  );
}

function ItinerarySurface({ progress }: { progress: number }) {
  const rows = [
    "Opening keynote",
    "Future of urban care",
    "Lunch + community tables",
    "Closing provocation",
  ];
  return (
    <div
      style={{
        width: 1430,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 90,
      }}
    >
      <div style={{ width: 590 }}>
        <Eyebrow tone="sage">04 · Itinerary</Eyebrow>
        <div
          style={{
            color: ink,
            fontSize: 63,
            lineHeight: 0.97,
            fontWeight: 860,
            letterSpacing: "-0.075em",
            marginTop: 17,
          }}
        >
          Build a personal
          <br />
          <span style={{ color: PALETTE.sageDeep }}>itinerary.</span>
        </div>
        <div
          style={{ color: muted, fontSize: 15, lineHeight: 1.5, marginTop: 22 }}
        >
          Attendees can save, share and revisit selected sessions.
        </div>
      </div>
      <div
        style={{
          width: 610,
          padding: 26,
          borderRadius: 24,
          background: paper,
          border: `1px solid ${line}`,
          boxShadow: "0 26px 75px rgba(24,37,34,.14)",
          transform: `translate3d(${interpolate(progress, [0, 1], [11, -9])}px, ${interpolate(progress, [0, 1], [7, -6])}px, 0)`,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            paddingBottom: 18,
            borderBottom: `1px solid ${line}`,
          }}
        >
          <div>
            <div
              style={{
                color: muted,
                fontSize: 10,
                fontWeight: 900,
                letterSpacing: "0.11em",
              }}
            >
              MY ITINERARY
            </div>
            <div
              style={{
                color: ink,
                fontSize: 22,
                fontWeight: 850,
                letterSpacing: "-0.04em",
                marginTop: 7,
              }}
            >
              Friday · 21 May 2027
            </div>
          </div>
          <Chip tone="copper">4 SESSIONS SAVED</Chip>
        </div>
        <div style={{ position: "relative" }}>
          <div
            style={{
              position: "absolute",
              left: 47,
              top: 14,
              bottom: 14,
              width: 2,
              zIndex: 0,
              background: "rgba(24,37,34,.12)",
            }}
          />
          <div
            style={{
              position: "absolute",
              left: 46,
              top: 14,
              bottom: 14,
              width: 4,
              zIndex: 1,
              borderRadius: 99,
              background:
                "linear-gradient(180deg, rgba(143,191,154,.92), rgba(190,98,66,.9))",
              transform: `scaleY(${progress})`,
              transformOrigin: "center top",
            }}
          />
          <div
            style={{
              position: "absolute",
              left: 43,
              top: 10,
              width: 12,
              height: 12,
              zIndex: 3,
              borderRadius: "50%",
              background: copper,
              border: `3px solid ${paper}`,
              boxSizing: "border-box",
              boxShadow: "0 4px 12px rgba(190,98,66,.36)",
              transform: `translate3d(0, ${interpolate(progress, [0, 1], [0, 171])}px, 0)`,
            }}
          />
          {rows.map((row, index) => (
            <div
              key={row}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 13,
                padding: "15px 0",
                borderBottom:
                  index < rows.length - 1 ? `1px solid ${line}` : undefined,
                position: "relative",
                zIndex: 2,
                transform: `translate3d(${interpolate(
                  ease(local(progress, index * 0.11, 0.36 + index * 0.11)),
                  [0, 1],
                  [10, 0],
                )}px, 0, 0)`,
              }}
            >
              <div
                style={{
                  color: muted,
                  width: 42,
                  fontSize: 11,
                  fontWeight: 800,
                }}
              >
                {["09:30", "10:30", "12:15", "16:40"][index]}
              </div>
              <div
                style={{ flex: 1, color: ink, fontSize: 13, fontWeight: 800 }}
              >
                {row}
              </div>
              <div
                style={{
                  width: 19,
                  height: 19,
                  borderRadius: "50%",
                  display: "grid",
                  placeItems: "center",
                  background: index === 1 ? copper : "rgba(143,191,154,.25)",
                  color: index === 1 ? paper : PALETTE.sageDeep,
                  fontSize: 11,
                }}
              >
                {index === 1 ? "✓" : "•"}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function EmbedsSurface({ progress }: { progress: number }) {
  const scanPosition = interpolate(progress, [0, 1], [-210, 1190]);
  return (
    <div
      style={{ width: 1560, display: "flex", alignItems: "center", gap: 42 }}
    >
      <div style={{ width: 360 }}>
        <Eyebrow tone="copper">05 · Embeds</Eyebrow>
        <div
          style={{
            color: ink,
            fontSize: 56,
            lineHeight: 0.98,
            fontWeight: 860,
            letterSpacing: "-0.07em",
            marginTop: 17,
          }}
        >
          Keep partner sites
          <br />
          <span style={{ color: copper }}>in step.</span>
        </div>
        <div
          style={{ color: muted, fontSize: 15, lineHeight: 1.5, marginTop: 20 }}
        >
          Managed embeds display the current published programme without manual
          exports.
        </div>
        <div
          style={{
            marginTop: 25,
            display: "flex",
            alignItems: "center",
            gap: 10,
            color: PALETTE.sageDeep,
            fontSize: 11,
            fontWeight: 850,
            letterSpacing: "0.1em",
          }}
        >
          <Check color={PALETTE.sageDeep} /> VERSIONED &amp; TRACEABLE
        </div>
      </div>
      <div style={{ height: 668, position: "relative", width: 1158 }}>
        <div
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: 30,
            background:
              "radial-gradient(circle at 18% 22%, rgba(190,98,66,.18), transparent 26%), radial-gradient(circle at 88% 72%, rgba(143,191,154,.18), transparent 34%), linear-gradient(135deg, rgba(24,37,34,.08), rgba(24,37,34,0))",
            transform: `translate3d(${interpolate(progress, [0, 1], [14, 30])}px, ${interpolate(progress, [0, 1], [30, 17])}px, 0)`,
          }}
        />
        <div
          style={{
            position: "absolute",
            right: 38,
            top: 32,
            zIndex: 4,
            display: "flex",
            gap: 10,
          }}
        >
          <Chip tone="copper">Published programme</Chip>
          <Chip tone="good">One published source</Chip>
        </div>
        <div
          style={{
            transform: `translate3d(0, ${interpolate(progress, [0, 1], [5, -5])}px, 0) scale(${interpolate(progress, [0, 1], [1.002, 1.012])})`,
            transformOrigin: "center center",
          }}
        >
          <AssetWindow
            src={ASSETS.publicProgramme}
            label="PUBLISHED PROGRAMME"
            caption="source view"
            width={1158}
            height={668}
            objectPosition={`center ${interpolate(progress, [0, 1], [14, 29])}%`}
            radius={30}
          />
        </div>
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 52,
            bottom: 18,
            width: 180,
            zIndex: 2,
            pointerEvents: "none",
            background:
              "linear-gradient(90deg, transparent, rgba(143,191,154,.06), rgba(255,253,248,.24), rgba(190,98,66,.08), transparent)",
            transform: `translate3d(${scanPosition}px, 0, 0) skewX(-7deg)`,
          }}
        />
        <div
          style={{
            position: "absolute",
            right: 34,
            top: 96,
            width: 460,
            zIndex: 3,
            display: "flex",
            flexDirection: "column",
            alignItems: "stretch",
            gap: 18,
            pointerEvents: "none",
            transform: `translate3d(0, ${interpolate(progress, [0, 1], [-7, 7])}px, 0)`,
          }}
        >
          <div
            style={{
              padding: "14px 17px",
              borderRadius: 16,
              background: "rgba(255,253,248,.88)",
              border: `1px solid rgba(24,37,34,.12)`,
              boxShadow: "0 14px 34px rgba(24,37,34,.1)",
            }}
          >
            <div
              style={{
                color: muted,
                fontSize: 10,
                fontWeight: 900,
                letterSpacing: "0.11em",
              }}
            >
              PUBLISHED SOURCE SNAPSHOT
            </div>
            <div
              style={{
                color: ink,
                fontSize: 21,
                fontWeight: 850,
                letterSpacing: "-0.05em",
                marginTop: 7,
              }}
            >
              Future of Events 2027
            </div>
            <div
              style={{
                display: "flex",
                gap: 14,
                flexWrap: "wrap",
                marginTop: 9,
                color: muted,
                fontSize: 11,
                fontWeight: 750,
              }}
            >
              <span>published programme</span>
              <span>linked profiles</span>
              <span>managed embed</span>
            </div>
          </div>
          <div
            style={{
              justifySelf: "end",
              alignSelf: "start",
              padding: "13px 15px",
              borderRadius: 16,
              background: "rgba(11,20,19,.76)",
              border: "1px solid rgba(255,255,255,.14)",
              boxShadow: "0 14px 34px rgba(0,0,0,.16)",
              color: paper,
              minWidth: 228,
            }}
          >
            <div
              style={{
                color: sage,
                fontSize: 10,
                fontWeight: 900,
                letterSpacing: "0.11em",
              }}
            >
              PUBLISHED SOURCE
            </div>
            <div
              style={{
                marginTop: 8,
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 8,
              }}
            >
              <Metric value="1" label="schedule revision" dark />
              <Metric value="1" label="published source" tone="copper" dark />
            </div>
          </div>
        </div>
        <div
          style={{
            background: "rgba(255,253,248,.9)",
            border: "1px solid rgba(24,37,34,.13)",
            borderRadius: 15,
            bottom: 24,
            boxShadow: "0 14px 34px rgba(24,37,34,.14)",
            color: paper,
            left: "auto",
            padding: "12px 15px 13px",
            position: "absolute",
            right: 62,
            width: 500,
            zIndex: 5,
          }}
        >
          <div
            style={{
              color: PALETTE.sageDeep,
              fontSize: 10,
              fontWeight: 900,
              letterSpacing: "0.13em",
            }}
          >
            PUBLISHED PROGRAMME EMBED
          </div>
          <div
            style={{
              color: "rgba(24,37,34,.62)",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: 12,
              lineHeight: 1.35,
              marginTop: 7,
              letterSpacing: 0,
            }}
          >
            The preview references the published programme source.
          </div>
        </div>
      </div>
    </div>
  );
}

function EventSiteSurface({ progress }: { progress: number }) {
  const sections = [
    "About the event",
    "Venue + access",
    "Sponsors",
    "Code of conduct",
    "FAQ",
  ];
  const navPosition = interpolate(progress, [0, 1], [0, sections.length - 1]);
  return (
    <div
      style={{ width: 1500, display: "flex", alignItems: "center", gap: 74 }}
    >
      <div style={{ width: 520 }}>
        <Eyebrow tone="sage">06 · Event site</Eyebrow>
        <div
          style={{
            color: paper,
            fontSize: 62,
            lineHeight: 0.97,
            fontWeight: 860,
            letterSpacing: "-0.075em",
            marginTop: 17,
          }}
        >
          Bring the whole event
          <br />
          <span style={{ color: sage }}>story together.</span>
        </div>
        <div
          style={{
            color: "rgba(255,253,248,.58)",
            fontSize: 15,
            lineHeight: 1.5,
            marginTop: 21,
          }}
        >
          Use fixed sections for About, Venue, Sponsors, Code of conduct and
          FAQ.
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 10,
            marginTop: 27,
            position: "relative",
          }}
        >
          <div
            style={{
              position: "absolute",
              left: -13,
              top: 0,
              width: 3,
              height: 22,
              borderRadius: 99,
              background: sage,
              boxShadow: "0 5px 16px rgba(143,191,154,.4)",
              transform: `translate3d(0, ${navPosition * 32}px, 0)`,
            }}
          />
          {sections.map((section, index) => (
            <div
              key={section}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                color: interpolateColors(
                  clamp(1 - Math.abs(index - navPosition)),
                  [0, 1],
                  ["rgba(255,253,248,.6)", paper],
                ),
                fontSize: 12,
                fontWeight: 750,
                transform: `translate3d(${interpolate(
                  clamp(1 - Math.abs(index - navPosition)),
                  [0, 1],
                  [0, 7],
                )}px, 0, 0)`,
              }}
            >
              <span
                style={{
                  width: 22,
                  height: 22,
                  display: "grid",
                  placeItems: "center",
                  borderRadius: 7,
                  background: interpolateColors(
                    clamp(1 - Math.abs(index - navPosition)),
                    [0, 1],
                    ["rgba(255,255,255,.1)", copper],
                  ),
                  color: interpolateColors(
                    clamp(1 - Math.abs(index - navPosition)),
                    [0, 1],
                    ["rgba(255,255,255,.55)", paper],
                  ),
                  fontSize: 10,
                  fontWeight: 900,
                }}
              >
                {String(index + 1).padStart(2, "0")}
              </span>
              {section}
            </div>
          ))}
        </div>
      </div>
      <div style={{ position: "relative", width: 840, height: 650 }}>
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 94,
            width: 410,
            height: 350,
            transform: `translate3d(${interpolate(progress, [0, 1], [-9, 7])}px, ${interpolate(progress, [0, 1], [9, -7])}px, 0) rotate(-3deg)`,
          }}
        >
          <AssetWindow
            src={ASSETS.publicSite}
            label="EVENT SITE · LIGHT"
            caption="fixed shell"
            width={410}
            height={350}
            objectPosition={`center ${interpolate(progress, [0, 1], [0, 76])}%`}
          />
        </div>
        <div
          style={{
            position: "absolute",
            left: 126,
            top: 10,
            width: 570,
            height: 560,
            transform: `translate3d(0, ${interpolate(progress, [0, 1], [-8, 8])}px, 0) rotate(${interpolate(progress, [0, 1], [0.5, 1.5])}deg)`,
          }}
        >
          <AssetWindow
            src={ASSETS.publicSiteDark}
            label="EVENT SITE · DARK"
            caption="fixed shell"
            width={570}
            height={560}
            objectPosition={`center ${interpolate(progress, [0, 1], [0, 84])}%`}
            dark
          />
          <PublishScrollRail progress={progress} height={466} dark />
        </div>
        <div
          style={{
            position: "absolute",
            right: 0,
            bottom: 0,
            width: 212,
            height: 420,
            transform: `translate3d(${interpolate(progress, [0, 1], [7, -8])}px, ${interpolate(progress, [0, 1], [-10, 10])}px, 0) rotate(-4deg)`,
          }}
        >
          <AssetWindow
            src={ASSETS.publicSiteMobile}
            label="EVENT SITE · MOBILE"
            caption="responsive"
            width={212}
            height={420}
            objectPosition={`center ${interpolate(progress, [0, 1], [0, 16])}%`}
            radius={22}
          />
        </div>
        <div
          style={{
            position: "absolute",
            right: 236,
            bottom: 36,
            padding: "10px 13px",
            borderRadius: 999,
            background: sage,
            color: ink,
            fontSize: 10,
            fontWeight: 900,
            letterSpacing: "0.08em",
            boxShadow: "0 14px 30px rgba(0,0,0,.3)",
          }}
        >
          PUBLISHED SITE
        </div>
      </div>
    </div>
  );
}

function PublishedOutcomeMoment({ progress }: { progress: number }) {
  const eased = ease(progress);
  const scale = interpolate(eased, [0, 1], [1.04, 1.075]);
  const imageShift = interpolate(eased, [0, 1], [-10, 10]);
  const thread = interpolate(eased, [0, 1], [0, 1]);
  return (
    <div
      style={{
        width: 1480,
        height: 710,
        position: "relative",
        overflow: "hidden",
        borderRadius: 30,
        border: "1px solid rgba(255,255,255,.13)",
        boxShadow: "0 40px 110px rgba(0,0,0,.38)",
      }}
    >
      <Img
        src={staticFile("video/illustrative-event-moment.png")}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          objectPosition: "center center",
          transform: `translate3d(${imageShift}px, 0, 0) scale(${scale})`,
          transformOrigin: "center center",
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "linear-gradient(90deg, rgba(7,15,14,.86) 0%, rgba(7,15,14,.5) 38%, rgba(7,15,14,.13) 66%, rgba(7,15,14,.68) 100%)",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 62,
          top: 58,
          display: "flex",
          gap: 10,
          alignItems: "center",
        }}
      >
        <Chip tone="copper" dark>
          Published programme
        </Chip>
        <Chip tone="good" dark>
          Ready for attendees
        </Chip>
      </div>
      <div style={{ position: "absolute", left: 66, top: 138, width: 500 }}>
        <Eyebrow tone="sage" dark>
          Published revision
        </Eyebrow>
        <div
          style={{
            color: paper,
            fontSize: 56,
            lineHeight: 0.98,
            fontWeight: 860,
            letterSpacing: "-0.07em",
            marginTop: 18,
          }}
        >
          Put the programme
          <br />
          in attendees’ hands
          <br />
          <span style={{ color: sage }}>before doors open.</span>
        </div>
        <div
          style={{
            color: "rgba(255,253,248,.66)",
            fontSize: 15,
            lineHeight: 1.5,
            marginTop: 20,
            maxWidth: 430,
          }}
        >
          Give attendees, speakers and organisers one current schedule wherever
          they look.
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 600,
          right: 82,
          top: 348,
          height: 2,
          background:
            "linear-gradient(90deg, rgba(143,191,154,.05), rgba(143,191,154,.88), rgba(246,197,169,.74), rgba(255,253,248,.05))",
          transform: `scaleX(${thread})`,
          transformOrigin: "left center",
        }}
      />
      <div
        style={{
          position: "absolute",
          right: 72,
          bottom: 58,
          display: "grid",
          gridTemplateColumns: "repeat(3, 178px)",
          gap: 12,
        }}
      >
        {[
          ["ATTENDEE", "published time and room"],
          ["SPEAKER", "published session slot"],
          ["OPS", "revision and changes recorded"],
        ].map(([role, outcome], index) => (
          <div
            key={role}
            style={{
              padding: "16px 15px",
              borderRadius: 15,
              background: "rgba(255,253,248,.9)",
              border: "1px solid rgba(255,255,255,.16)",
              opacity: ease(
                local(progress, 0.18 + index * 0.14, 0.4 + index * 0.14),
              ),
            }}
          >
            <div
              style={{
                color: index === 2 ? copperText : PALETTE.sageDeep,
                fontSize: 10,
                fontWeight: 900,
                letterSpacing: "0.12em",
              }}
            >
              {role}
            </div>
            <div
              style={{
                color: ink,
                fontSize: 17,
                lineHeight: 1.15,
                fontWeight: 850,
                letterSpacing: "-0.035em",
                marginTop: 10,
              }}
            >
              {outcome}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function PublishScene({ duration }: SceneProps) {
  const frame = useCurrentFrame();
  const progress = frameProgress(frame, duration);
  const hero = cut(progress, 0, 0.14);
  const programme = cut(progress, 0.14, 0.28);
  const day = cut(progress, 0.28, 0.42);
  const speakers = cut(progress, 0.42, 0.56);
  const itinerary = cut(progress, 0.56, 0.69);
  const embeds = after(progress, 0.69);
  const site = cut(progress, 0.82, 0.91);
  const outcome = after(progress, 0.91);
  const heroProgress = local(progress, 0, 0.14);
  const programmeProgress = local(progress, 0.14, 0.28);
  const dayProgress = local(progress, 0.28, 0.42);
  const speakersProgress = local(progress, 0.42, 0.56);
  const itineraryProgress = local(progress, 0.56, 0.69);
  const embedsProgress = local(progress, 0.69, 0.82);
  const siteProgress = local(progress, 0.82, 0.91);
  const outcomeProgress = local(progress, 0.91, 1);
  const siteTransition = Easing.inOut(Easing.cubic)(
    local(progress, 0.82, 0.842),
  );
  const siteTransitionStarted = siteTransition > 0.001;
  const siteTransitionSettled = siteTransition >= 0.999;
  const theme = siteTransition;
  const background = interpolateColors(theme, [0, 1], [canvas, deep]);
  const lightFieldX = interpolate(progress, [0, 1], [-20, 24]);
  const darkFieldX = interpolate(progress, [0, 1], [18, -22]);
  return (
    <AbsoluteFill
      style={{
        background,
        overflow: "hidden",
        fontFamily: "Program Cue Inter, Inter, sans-serif",
      }}
    >
      <DotGrid opacity={(1 - theme) * 0.22} dark={false} />
      <DotGrid opacity={theme * 0.3} />
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(circle at 89% 17%, rgba(190,98,66,.1), transparent 29%), radial-gradient(circle at 7% 80%, rgba(143,191,154,.12), transparent 32%)",
          opacity: 1 - theme,
          transform: `translate3d(${lightFieldX}px, ${interpolate(progress, [0, 1], [-12, 14])}px, 0) scale(1.025)`,
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(circle at 78% 50%, rgba(143,191,154,.13), transparent 33%), radial-gradient(circle at 10% 12%, rgba(190,98,66,.13), transparent 29%)",
          opacity: theme,
          transform: `translate3d(${darkFieldX}px, ${interpolate(progress, [0, 1], [12, -14])}px, 0) scale(1.025)`,
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 40,
          opacity: 1 - theme,
          pointerEvents: "none",
        }}
      >
        <SceneHeader
          chapter="PUBLISHED PROGRAMME"
          index="11 / 13 · PUBLISH"
          progress={progress}
          dark={false}
        />
      </div>
      <div
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 40,
          opacity: theme,
          pointerEvents: "none",
        }}
      >
        <SceneHeader
          chapter="PUBLISHED PROGRAMME"
          index="11 / 13 · PUBLISH"
          progress={progress}
        />
      </div>
      <PublishSurfaceLayer
        active={hero === 1}
        left={184}
        progress={heroProgress}
        top={188}
        zIndex={5}
      >
        <PublishHero progress={heroProgress} />
      </PublishSurfaceLayer>
      <PublishSurfaceLayer
        active={programme === 1}
        left={140}
        progress={programmeProgress}
        top={140}
        zIndex={8}
      >
        <ProgrammeSurface progress={programmeProgress} />
      </PublishSurfaceLayer>
      <PublishSurfaceLayer
        active={day === 1}
        left={220}
        progress={dayProgress}
        top={154}
        zIndex={10}
      >
        <DayByDaySurface progress={dayProgress} />
      </PublishSurfaceLayer>
      <PublishSurfaceLayer
        active={speakers === 1}
        left={250}
        progress={speakersProgress}
        top={154}
        zIndex={12}
      >
        <SpeakersSurface progress={speakersProgress} />
      </PublishSurfaceLayer>
      <PublishSurfaceLayer
        active={itinerary === 1}
        left={245}
        progress={itineraryProgress}
        top={168}
        zIndex={14}
      >
        <ItinerarySurface progress={itineraryProgress} />
      </PublishSurfaceLayer>
      <PublishSurfaceLayer
        active={embeds === 1}
        left={214}
        maskDirection="outgoing"
        maskProgress={siteTransition}
        progress={embedsProgress}
        top={168}
        zIndex={16}
      >
        <EmbedsSurface progress={embedsProgress} />
      </PublishSurfaceLayer>
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "linear-gradient(90deg, rgba(13,25,23,.98) 0%, rgba(13,25,23,.96) 45%, rgba(13,25,23,.7) 64%, rgba(13,25,23,0) 100%)",
          clipPath:
            siteTransitionStarted && !siteTransitionSettled
              ? `inset(0 ${interpolate(siteTransition, [0, 1], [100, 0])}% 0 0)`
              : undefined,
          opacity: siteTransitionStarted ? 1 : 0,
          pointerEvents: "none",
          zIndex: 17,
        }}
      />
      <PublishSurfaceLayer
        active={site === 1}
        left={196}
        maskProgress={siteTransition}
        progress={siteProgress}
        top={142}
        zIndex={18}
      >
        <EventSiteSurface progress={siteProgress} />
      </PublishSurfaceLayer>
      <div
        style={{
          position: "absolute",
          left: interpolate(siteTransition, [0, 1], [-8, 1928]),
          top: 0,
          bottom: 0,
          width: 3,
          zIndex: 19,
          opacity: Math.sin(siteTransition * Math.PI),
          background: sage,
          boxShadow:
            "0 0 22px rgba(143,191,154,.56), -12px 0 42px rgba(11,20,19,.34)",
          pointerEvents: "none",
        }}
      />
      <PublishSurfaceLayer
        active={outcome === 1}
        left={220}
        progress={outcomeProgress}
        top={150}
        zIndex={20}
      >
        <PublishedOutcomeMoment progress={outcomeProgress} />
      </PublishSurfaceLayer>
      <div
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 30,
          opacity: 1 - theme,
          pointerEvents: "none",
        }}
      >
        <FooterRail
          progress={progress}
          items={["source", "schedule", "people", "path", "embed", "site"]}
          dark={false}
        />
      </div>
      <div
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 30,
          opacity: theme,
          pointerEvents: "none",
        }}
      >
        <FooterRail
          progress={progress}
          items={["source", "schedule", "people", "path", "embed", "site"]}
        />
      </div>
    </AbsoluteFill>
  );
}
