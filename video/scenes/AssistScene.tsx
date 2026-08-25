import {
  Activity,
  Bell,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronRight,
  FileText,
  Home,
  Mail,
  MousePointer2,
  Plus,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Users,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import {
  AbsoluteFill,
  Easing,
  interpolate,
  interpolateColors,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

import {
  BrowserFrame,
  SubtleGrain,
  SubtleGrid,
} from "../components/Primitives";
import { ProgramCueMark } from "../components/ProgramCueBrand";
import { PALETTE } from "../constants";

export type AssistSceneProps = {
  duration: number;
};

const clamp = (value: number) => Math.min(1, Math.max(0, value));
const local = (value: number, start: number, end: number) =>
  clamp((value - start) / Math.max(0.0001, end - start));
const ease = (value: number) => Easing.bezier(0.22, 1, 0.36, 1)(clamp(value));
const CLAMP = {
  extrapolateLeft: "clamp" as const,
  extrapolateRight: "clamp" as const,
};

const ink = PALETTE.ink;
const deep = PALETTE.inkDeep;
const paper = PALETTE.paper;
const canvas = PALETTE.canvas;
const copper = PALETTE.copper;
const copperDeep = PALETTE.copperDeep;
const sage = PALETTE.sage;
const gold = PALETTE.gold;
const line = PALETTE.line;
const muted = PALETTE.muted;

const stageVisible = (progress: number, start: number, end: number) =>
  progress >= start && progress < end ? 1 : 0;

function StatusPill({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "warning" | "info" | "danger";
}) {
  const colors = {
    neutral: {
      background: "rgba(24,37,34,.055)",
      border: "rgba(24,37,34,.13)",
      color: muted,
    },
    good: {
      background: "rgba(143,191,154,.14)",
      border: "rgba(58,95,66,.24)",
      color: PALETTE.sageDeep,
    },
    warning: {
      background: "rgba(212,167,44,.12)",
      border: "rgba(212,167,44,.3)",
      color: "#806315",
    },
    info: {
      background: "rgba(55,112,142,.1)",
      border: "rgba(55,112,142,.24)",
      color: "#285d76",
    },
    danger: {
      background: "rgba(220,38,38,.075)",
      border: "rgba(220,38,38,.22)",
      color: "#a52b27",
    },
  }[tone];
  return (
    <span
      style={{
        alignItems: "center",
        background: colors.background,
        border: `1px solid ${colors.border}`,
        borderRadius: 999,
        color: colors.color,
        display: "inline-flex",
        fontSize: 11,
        fontWeight: 780,
        gap: 6,
        letterSpacing: ".015em",
        lineHeight: 1,
        minHeight: 27,
        padding: "0 10px",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

function AppButton({
  children,
  primary = false,
  pressed = false,
  small = false,
}: {
  children: ReactNode;
  primary?: boolean;
  pressed?: boolean;
  small?: boolean;
}) {
  return (
    <div
      style={{
        alignItems: "center",
        background: primary ? ink : paper,
        border: `1px solid ${primary ? ink : "rgba(24,37,34,.19)"}`,
        borderRadius: 9,
        boxShadow: primary
          ? "0 8px 18px rgba(24,37,34,.16)"
          : "0 2px 5px rgba(24,37,34,.035)",
        color: primary ? paper : ink,
        display: "inline-flex",
        fontSize: small ? 11 : 13,
        fontWeight: 760,
        gap: 8,
        minHeight: small ? 31 : 38,
        padding: small ? "0 11px" : "0 14px",
        transform: pressed ? "translateY(1px) scale(.985)" : "none",
      }}
    >
      {children}
    </div>
  );
}

function Card({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        background: "rgba(255,255,255,.82)",
        border: `1px solid ${line}`,
        borderRadius: 15,
        boxShadow: "0 8px 24px rgba(24,37,34,.045)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function AppShell({
  active,
  children,
  progress,
}: {
  active: "home" | "operations" | "none";
  children: ReactNode;
  progress: number;
}) {
  const navigation = [
    { icon: Home, label: "Home", key: "home" },
    { icon: FileText, label: "Applications", key: "applications" },
    { icon: Users, label: "Speakers", key: "speakers" },
    { icon: CalendarDays, label: "Programme", key: "programme" },
    { icon: Mail, label: "Communications", key: "communications" },
  ] as const;
  const administration = [
    { icon: Settings, label: "Event settings", key: "settings" },
    { icon: Activity, label: "Operations", key: "operations" },
  ] as const;
  const shellGlow = interpolate(
    Math.sin(progress * Math.PI * 2),
    [-1, 1],
    [0.1, 0.22],
  );
  return (
    <AbsoluteFill
      style={{
        background: canvas,
        color: ink,
        fontFamily:
          "Program Cue Inter, Inter, ui-sans-serif, system-ui, sans-serif",
      }}
    >
      <div
        style={{
          alignItems: "center",
          background: "#12221f",
          borderBottom: "1px solid rgba(255,253,248,.09)",
          color: paper,
          display: "flex",
          height: 72,
          left: 210,
          padding: "0 22px",
          position: "absolute",
          right: 0,
          top: 0,
          zIndex: 4,
        }}
      >
        <div
          style={{
            alignItems: "center",
            background: "rgba(255,253,248,.055)",
            border: "1px solid rgba(143,191,154,.22)",
            borderRadius: 10,
            display: "flex",
            gap: 11,
            height: 48,
            padding: "0 13px",
            width: 510,
          }}
        >
          <div
            style={{
              alignItems: "center",
              background: "rgba(143,191,154,.12)",
              border: "1px solid rgba(143,191,154,.28)",
              borderRadius: 7,
              color: "#c8ebd0",
              display: "flex",
              fontSize: 12,
              fontWeight: 800,
              height: 30,
              justifyContent: "center",
              width: 34,
            }}
          >
            FO
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 780 }}>
              Future of Events 2027
            </div>
            <div
              style={{
                color: "rgba(255,253,248,.58)",
                fontSize: 10,
                marginTop: 3,
              }}
            >
              May 20–22, 2027 · Toronto · America/Toronto
            </div>
          </div>
          <span style={{ marginLeft: "auto", opacity: 0.55 }}>⌄</span>
        </div>
        <div
          style={{
            alignItems: "center",
            background: `rgba(255,253,248,${0.055 + shellGlow})`,
            border: "1px solid rgba(255,253,248,.13)",
            borderRadius: 10,
            color: "rgba(255,253,248,.68)",
            display: "flex",
            fontSize: 13,
            gap: 10,
            height: 43,
            marginLeft: 16,
            padding: "0 14px",
            width: 420,
          }}
        >
          <Search size={15} />
          <span>Search or run a command…</span>
          <span
            style={{
              border: "1px solid rgba(255,253,248,.15)",
              borderRadius: 5,
              fontSize: 10,
              marginLeft: "auto",
              padding: "3px 6px",
            }}
          >
            ⌘K
          </span>
        </div>
        <div style={{ display: "flex", gap: 10, marginLeft: "auto" }}>
          <div
            style={{
              alignItems: "center",
              border: "1px solid rgba(255,253,248,.16)",
              borderRadius: 9,
              display: "flex",
              fontSize: 12,
              fontWeight: 720,
              gap: 7,
              height: 40,
              padding: "0 12px",
            }}
          >
            <Plus size={15} /> New
          </div>
          <div
            style={{
              alignItems: "center",
              border: "1px solid rgba(255,253,248,.16)",
              borderRadius: 9,
              display: "flex",
              height: 40,
              justifyContent: "center",
              width: 40,
            }}
          >
            <Bell size={15} />
          </div>
          <div
            style={{
              alignItems: "center",
              background: "rgba(143,191,154,.13)",
              border: "1px solid rgba(143,191,154,.22)",
              borderRadius: 999,
              color: "#d3edda",
              display: "flex",
              fontSize: 11,
              fontWeight: 820,
              height: 40,
              justifyContent: "center",
              width: 40,
            }}
          >
            JA
          </div>
        </div>
      </div>

      <aside
        style={{
          background: "#10201d",
          bottom: 0,
          color: paper,
          left: 0,
          position: "absolute",
          top: 0,
          width: 210,
          zIndex: 5,
        }}
      >
        <div
          style={{
            alignItems: "center",
            display: "flex",
            gap: 10,
            height: 72,
            padding: "0 17px",
          }}
        >
          <ProgramCueMark size={28} />
          <span style={{ fontSize: 16, fontWeight: 820 }}>Program Cue</span>
        </div>
        <div
          style={{
            color: "rgba(255,253,248,.46)",
            fontSize: 10,
            fontWeight: 780,
            letterSpacing: ".04em",
            padding: "10px 16px 7px",
          }}
        >
          Event work
        </div>
        {navigation.map((item) => {
          const Icon = item.icon;
          const selected = active === item.key;
          return (
            <div
              key={item.key}
              style={{
                alignItems: "center",
                background: selected ? "rgba(255,253,248,.09)" : "transparent",
                borderLeft: selected
                  ? `3px solid ${copper}`
                  : "3px solid transparent",
                color: selected ? paper : "rgba(255,253,248,.75)",
                display: "flex",
                fontSize: 13,
                fontWeight: selected ? 740 : 540,
                gap: 11,
                height: 41,
                padding: "0 15px",
              }}
            >
              <Icon size={15} strokeWidth={1.8} />
              {item.label}
            </div>
          );
        })}
        <div
          style={{
            borderTop: "1px solid rgba(255,253,248,.1)",
            color: "rgba(255,253,248,.46)",
            fontSize: 10,
            fontWeight: 780,
            letterSpacing: ".04em",
            marginTop: 10,
            padding: "14px 16px 7px",
          }}
        >
          Administration
        </div>
        {administration.map((item) => {
          const Icon = item.icon;
          const selected = active === item.key;
          return (
            <div
              key={item.key}
              style={{
                alignItems: "center",
                background: selected ? "rgba(255,253,248,.09)" : "transparent",
                borderLeft: selected
                  ? `3px solid ${copper}`
                  : "3px solid transparent",
                color: selected ? paper : "rgba(255,253,248,.75)",
                display: "flex",
                fontSize: 13,
                fontWeight: selected ? 740 : 540,
                gap: 11,
                height: 41,
                padding: "0 15px",
              }}
            >
              <Icon size={15} strokeWidth={1.8} />
              {item.label}
            </div>
          );
        })}
        <div
          style={{
            bottom: 18,
            color: "rgba(255,253,248,.64)",
            fontSize: 10,
            left: 17,
            position: "absolute",
          }}
        >
          <span style={{ color: gold, marginRight: 7 }}>●</span>
          Event administrator
        </div>
      </aside>
      <main
        style={{
          bottom: 0,
          left: 210,
          overflow: "hidden",
          position: "absolute",
          right: 0,
          top: 72,
        }}
      >
        {children}
      </main>
    </AbsoluteFill>
  );
}

function FilmPointer({
  x,
  y,
  opacity,
  click = 0,
  label,
}: {
  x: number;
  y: number;
  opacity: number;
  click?: number;
  label?: string;
}) {
  return (
    <div
      style={{
        left: x,
        opacity,
        pointerEvents: "none",
        position: "absolute",
        top: y,
        transform: `translate3d(-2px,-2px,0) scale(${1 - click * 0.08})`,
        zIndex: 40,
      }}
    >
      {click > 0 ? (
        <span
          style={{
            border: `2px solid ${copper}`,
            borderRadius: 999,
            height: 38,
            left: -14,
            opacity: 1 - click,
            position: "absolute",
            top: -14,
            transform: `scale(${0.5 + click * 0.85})`,
            width: 38,
          }}
        />
      ) : null}
      <MousePointer2
        color={ink}
        fill={paper}
        size={29}
        strokeWidth={1.8}
        style={{ filter: "drop-shadow(0 4px 6px rgba(0,0,0,.38))" }}
      />
      {label ? (
        <span
          style={{
            background: copper,
            borderRadius: 6,
            color: paper,
            fontSize: 10,
            fontWeight: 780,
            left: 24,
            padding: "6px 8px",
            position: "absolute",
            top: 23,
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </span>
      ) : null}
    </div>
  );
}

function clickPulse(value: number, at: number, width = 0.055) {
  const distance = Math.abs(value - at) / width;
  return clamp(1 - distance);
}

function CommandCentreStage({ progress }: { progress: number }) {
  const stage = local(progress, 0, 0.205);
  const palette = ease(local(stage, 0.44, 0.59));
  const paletteSelection = ease(local(stage, 0.63, 0.94));
  const cursorX =
    stage < 0.54
      ? interpolate(ease(local(stage, 0.1, 0.48)), [0, 1], [1160, 1080])
      : interpolate(paletteSelection, [0, 1], [1080, 940]);
  const cursorY =
    stage < 0.54
      ? interpolate(ease(local(stage, 0.1, 0.48)), [0, 1], [290, 42])
      : interpolate(paletteSelection, [0, 1], [42, 309]);
  const cursorOpacity = interpolate(
    stage,
    [0.08, 0.16, 0.98],
    [0, 1, 1],
    CLAMP,
  );
  const click = Math.max(clickPulse(stage, 0.49), clickPulse(stage, 0.93));
  const layerOpacity = stageVisible(progress, 0, 0.205);
  return (
    <AbsoluteFill style={{ opacity: layerOpacity }}>
      <AppShell active="home" progress={progress}>
        <div
          style={{
            padding: "28px 34px 36px",
            transform: `translate3d(0, ${interpolate(ease(stage), [0, 1], [3, -3])}px, 0)`,
          }}
        >
          <div
            style={{
              color: muted,
              fontSize: 11,
              fontWeight: 650,
              marginBottom: 16,
            }}
          >
            Future Events Association&nbsp; › &nbsp;
            <strong style={{ color: ink }}>Future of Events 2027</strong>
          </div>
          <div
            style={{
              alignItems: "center",
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            <h1
              style={{
                fontSize: 42,
                letterSpacing: "-.045em",
                lineHeight: 1,
                margin: 0,
              }}
            >
              Command Centre
            </h1>
            <div style={{ display: "flex", gap: 8 }}>
              <StatusPill tone="good">● Live</StatusPill>
              <AppButton small>Event settings</AppButton>
            </div>
          </div>
          <div
            style={{
              borderBottom: `1px solid ${line}`,
              display: "grid",
              gap: 34,
              gridTemplateColumns: ".9fr 1.25fr",
              marginTop: 20,
              paddingBottom: 22,
            }}
          >
            <div>
              <div style={{ fontSize: 14, fontWeight: 760 }}>
                Overall readiness
              </div>
              <div
                style={{
                  alignItems: "baseline",
                  display: "flex",
                  gap: 9,
                  marginTop: 5,
                }}
              >
                <strong
                  style={{
                    fontSize: 68,
                    letterSpacing: "-.065em",
                    lineHeight: 1,
                  }}
                >
                  75
                </strong>
                <strong style={{ fontSize: 25 }}>%</strong>
                <span
                  style={{
                    color: PALETTE.sageDeep,
                    fontSize: 12,
                    fontWeight: 780,
                  }}
                >
                  On track
                </span>
              </div>
              <div
                style={{
                  background: "rgba(24,37,34,.09)",
                  borderRadius: 999,
                  height: 7,
                  marginTop: 12,
                  overflow: "hidden",
                  width: "96%",
                }}
              >
                <div
                  style={{
                    background: `linear-gradient(90deg, ${copper}, ${sage})`,
                    height: "100%",
                    width: `${interpolate(ease(local(stage, 0.04, 0.32)), [0, 1], [0, 75])}%`,
                  }}
                />
              </div>
              <p style={{ color: muted, fontSize: 11, margin: "10px 0 0" }}>
                Equal weight across 6 workflows, capped by programme setup.
              </p>
            </div>
            <div>
              <div
                style={{
                  alignItems: "center",
                  display: "flex",
                  fontSize: 14,
                  fontWeight: 760,
                  justifyContent: "space-between",
                }}
              >
                Action queue
                <span style={{ color: muted, fontSize: 11, fontWeight: 600 }}>
                  2 conditions
                </span>
              </div>
              {[
                {
                  label: "Critical tasks incomplete",
                  detail: "Resolve critical work",
                  count: "1",
                  tone: "#b8332f",
                },
                {
                  label: "Missing speaker assets",
                  detail: "Follow up with speakers",
                  count: "1",
                  tone: "#886a14",
                },
              ].map((item) => (
                <div
                  key={item.label}
                  style={{
                    alignItems: "center",
                    borderBottom: `1px solid ${line}`,
                    display: "grid",
                    gridTemplateColumns: "25px 1fr auto 18px",
                    minHeight: 51,
                  }}
                >
                  <span style={{ color: item.tone, fontSize: 15 }}>◉</span>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 780 }}>
                      {item.label}
                    </div>
                    <div style={{ color: muted, fontSize: 10, marginTop: 3 }}>
                      {item.detail}
                    </div>
                  </div>
                  <span
                    style={{
                      background: `${item.tone}12`,
                      borderRadius: 999,
                      color: item.tone,
                      fontSize: 10,
                      fontWeight: 820,
                      padding: "4px 7px",
                    }}
                  >
                    {item.count}
                  </span>
                  <ChevronRight color={item.tone} size={15} />
                </div>
              ))}
            </div>
          </div>
          <div style={{ marginTop: 18 }}>
            <div style={{ fontSize: 14, fontWeight: 760, marginBottom: 8 }}>
              Workflows
            </div>
            {[
              [
                "Speakers & materials",
                "Impact-weighted speaker task readiness",
                33,
              ],
              [
                "Content & submissions",
                "Submissions with a recorded outcome",
                50,
              ],
              ["Review", "Active assignments submitted", 67],
              [
                "Schedule",
                "Sessions scheduled without blocking conflicts",
                100,
              ],
            ].map(([label, detail, score]) => {
              const value = Number(score);
              const speaker = label === "Speakers & materials";
              return (
                <div
                  key={String(label)}
                  style={{
                    alignItems: "center",
                    background: speaker
                      ? "rgba(190,98,66,.045)"
                      : "transparent",
                    borderBottom: `1px solid ${line}`,
                    borderRadius: speaker ? 9 : 0,
                    display: "grid",
                    gridTemplateColumns: "260px 1fr 230px 48px",
                    minHeight: 43,
                    padding: speaker ? "0 9px" : "0 9px",
                  }}
                >
                  <strong style={{ fontSize: 12 }}>{label}</strong>
                  <span style={{ color: muted, fontSize: 10 }}>{detail}</span>
                  <div
                    style={{
                      background: "rgba(24,37,34,.075)",
                      height: 5,
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        background: speaker
                          ? "#c34138"
                          : value < 100
                            ? copper
                            : "#bdc5bd",
                        height: "100%",
                        width: `${value}%`,
                      }}
                    />
                  </div>
                  <strong style={{ fontSize: 12, textAlign: "right" }}>
                    {value}%
                  </strong>
                </div>
              );
            })}
          </div>
        </div>

        {palette > 0 ? (
          <>
            <AbsoluteFill
              style={{
                background: `rgba(5,12,11,${palette * 0.45})`,
                opacity: palette,
                zIndex: 20,
              }}
            />
            <div
              style={{
                background: paper,
                border: "1px solid rgba(255,255,255,.5)",
                borderRadius: 17,
                boxShadow: "0 34px 90px rgba(0,0,0,.36)",
                left: "50%",
                opacity: palette,
                overflow: "hidden",
                position: "absolute",
                top: 76,
                transform: `translate3d(-50%, ${interpolate(palette, [0, 1], [-18, 0])}px, 0) scale(${0.98 + palette * 0.02})`,
                width: 760,
                zIndex: 30,
              }}
            >
              <div
                style={{
                  alignItems: "center",
                  borderBottom: `1px solid ${line}`,
                  display: "flex",
                  gap: 12,
                  height: 62,
                  padding: "0 20px",
                }}
              >
                <Search color={muted} size={19} />
                <span style={{ fontSize: 16, fontWeight: 580 }}>assistant</span>
                <span
                  style={{
                    border: `1px solid ${line}`,
                    borderRadius: 6,
                    color: muted,
                    fontSize: 10,
                    marginLeft: "auto",
                    padding: "4px 7px",
                  }}
                >
                  ESC
                </span>
              </div>
              <div style={{ padding: "13px" }}>
                <div
                  style={{
                    color: muted,
                    fontSize: 10,
                    fontWeight: 800,
                    letterSpacing: ".08em",
                    padding: "4px 9px 8px",
                    textTransform: "uppercase",
                  }}
                >
                  Ask assistant
                </div>
                <div
                  style={{
                    alignItems: "center",
                    background: interpolateColors(
                      paletteSelection,
                      [0, 1],
                      ["rgba(24,37,34,.025)", "rgba(190,98,66,.1)"],
                    ),
                    border: `1px solid ${interpolateColors(
                      paletteSelection,
                      [0, 1],
                      ["rgba(24,37,34,.06)", "rgba(190,98,66,.28)"],
                    )}`,
                    borderRadius: 11,
                    display: "grid",
                    gap: 12,
                    gridTemplateColumns: "38px 1fr auto",
                    minHeight: 68,
                    padding: "0 14px",
                  }}
                >
                  <div
                    style={{
                      alignItems: "center",
                      background: "rgba(190,98,66,.11)",
                      borderRadius: 9,
                      color: copper,
                      display: "flex",
                      height: 36,
                      justifyContent: "center",
                      width: 36,
                    }}
                  >
                    <Sparkles size={18} />
                  </div>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 780 }}>
                      Ask about this event
                    </div>
                    <div style={{ color: muted, fontSize: 11, marginTop: 4 }}>
                      Answers are grounded in the current records
                    </div>
                  </div>
                  <span style={{ color: muted, fontSize: 10, fontWeight: 700 }}>
                    Open assistant
                  </span>
                </div>
              </div>
            </div>
          </>
        ) : null}
        <FilmPointer
          x={cursorX}
          y={cursorY}
          opacity={cursorOpacity}
          click={click}
        />
      </AppShell>
    </AbsoluteFill>
  );
}

function EvidenceCard({
  delay,
  detail,
  label,
  progress,
}: {
  delay: number;
  detail: string;
  label: string;
  progress: number;
}) {
  const reveal = ease(local(progress, delay, delay + 0.14));
  return (
    <div
      style={{
        alignItems: "center",
        background: "rgba(143,191,154,.075)",
        border: "1px solid rgba(58,95,66,.19)",
        borderRadius: 11,
        display: "grid",
        gap: 10,
        gridTemplateColumns: "34px 1fr auto",
        minHeight: 57,
        opacity: reveal,
        padding: "0 13px",
        transform: `translateX(${interpolate(reveal, [0, 1], [16, 0])}px)`,
      }}
    >
      <div
        style={{
          alignItems: "center",
          background: "rgba(143,191,154,.18)",
          borderRadius: 8,
          color: PALETTE.sageDeep,
          display: "flex",
          height: 32,
          justifyContent: "center",
          width: 32,
        }}
      >
        <ShieldCheck size={17} />
      </div>
      <div>
        <div style={{ fontSize: 13, fontWeight: 780 }}>{label}</div>
        <div style={{ color: muted, fontSize: 11, marginTop: 3 }}>{detail}</div>
      </div>
      <span
        style={{
          color: PALETTE.sageDeep,
          fontSize: 10,
          fontWeight: 820,
          letterSpacing: ".05em",
        }}
      >
        PROGRAM CUE RECORDS
      </span>
    </div>
  );
}

function AssistantStage({ progress }: { progress: number }) {
  const stage = local(progress, 0.205, 0.486);
  const layerOpacity = stageVisible(progress, 0.205, 0.486);
  const requestChosen = ease(local(stage, 0.08, 0.22));
  const pending = local(stage, 0.2, 0.54);
  const answer = ease(local(stage, 0.49, 0.68));
  const evidenceReady = ease(local(stage, 0.38, 0.49));
  const pointerX = interpolate(requestChosen, [0, 1], [1165, 1110]);
  const pointerY = interpolate(requestChosen, [0, 1], [305, 312]);
  const toolSteps = [
    { label: "Event-scoped records", tone: sage },
    { label: "Published template", tone: copper },
    { label: "Action ready", tone: gold },
  ];
  return (
    <AbsoluteFill style={{ opacity: layerOpacity }}>
      <AppShell active="none" progress={progress}>
        <div
          style={{
            boxSizing: "border-box",
            height: "100%",
            padding: "24px 32px 30px",
          }}
        >
          <div
            style={{
              margin: "0 auto",
              transform: "scale(1.13)",
              transformOrigin: "50% 0",
              width: "88.5%",
            }}
          >
            <div
              style={{
                alignItems: "flex-start",
                display: "flex",
                justifyContent: "space-between",
              }}
            >
              <div>
                <div
                  style={{
                    color: copperDeep,
                    fontSize: 10,
                    fontWeight: 840,
                    letterSpacing: ".11em",
                    textTransform: "uppercase",
                  }}
                >
                  Event-aware tools
                </div>
                <h1
                  style={{
                    fontSize: 39,
                    letterSpacing: "-.045em",
                    lineHeight: 1,
                    margin: "8px 0 0",
                  }}
                >
                  Event Assistant
                </h1>
                <p style={{ color: muted, fontSize: 12, margin: "10px 0 0" }}>
                  Turn event records into clear, ready-to-run actions.
                </p>
              </div>
              <AppButton small>Open Command Centre</AppButton>
            </div>

            <div
              style={{
                alignItems: "center",
                background: "rgba(143,191,154,.085)",
                border: "1px solid rgba(58,95,66,.18)",
                borderRadius: 11,
                display: "flex",
                fontSize: 11,
                gap: 9,
                marginTop: 18,
                minHeight: 42,
                padding: "0 13px",
              }}
            >
              <ShieldCheck color={PALETTE.sageDeep} size={16} />
              <strong>Built from your event</strong>
              <span style={{ color: muted }}>
                Find the work. Draft the action. Keep the organiser in command.
              </span>
            </div>

            <div
              style={{
                display: "grid",
                gap: 23,
                gridTemplateColumns: "1.38fr .82fr",
                marginTop: 20,
                minHeight: 330,
              }}
            >
              <div style={{ minHeight: 330 }}>
                <div style={{ fontSize: 13, fontWeight: 780, marginBottom: 9 }}>
                  What do you need to know or prepare?
                </div>
                <Card style={{ padding: 15 }}>
                  <div style={{ color: muted, fontSize: 10, fontWeight: 760 }}>
                    Request
                  </div>
                  <div
                    style={{
                      background: "#fff",
                      border: `1px solid ${line}`,
                      borderRadius: 9,
                      color: ink,
                      fontSize: 14,
                      lineHeight: 1.45,
                      marginTop: 7,
                      minHeight: 126,
                      padding: "13px 14px",
                      position: "relative",
                    }}
                  >
                    <span
                      style={{
                        left: 14,
                        opacity: requestChosen >= 0.5 ? 1 : 0,
                        position: "absolute",
                        right: 14,
                        top: 13,
                      }}
                    >
                      Find speakers with incomplete tasks and draft a
                      personalised reminder for my approval.
                    </span>
                    <span
                      style={{
                        color: "#9aa5a0",
                        left: 14,
                        opacity: requestChosen < 0.5 ? 1 : 0,
                        position: "absolute",
                        right: 14,
                        top: 13,
                      }}
                    >
                      What is blocking event readiness?
                    </span>
                  </div>
                  <div
                    style={{
                      alignItems: "center",
                      display: "flex",
                      justifyContent: "space-between",
                      marginTop: 11,
                    }}
                  >
                    <span style={{ color: muted, fontSize: 10 }}>
                      Focused on this event&apos;s records.
                    </span>
                    <AppButton
                      primary
                      pressed={clickPulse(stage, 0.24) > 0.25}
                      small
                    >
                      <Sparkles size={13} />
                      {pending < 0.92
                        ? "Ask assistant"
                        : "Reviewing event records…"}
                    </AppButton>
                  </div>
                </Card>

                {pending > 0.02 && answer < 0.98 ? (
                  <div
                    style={{
                      alignItems: "center",
                      display: "flex",
                      gap: 8,
                      marginTop: 13,
                      opacity: Math.min(1, pending * 4),
                    }}
                  >
                    {toolSteps.map((tool, index) => {
                      const active = ease(
                        local(pending, index * 0.24, index * 0.24 + 0.28),
                      );
                      return (
                        <div
                          key={tool.label}
                          style={{
                            alignItems: "center",
                            background: `${tool.tone}10`,
                            border: `1px solid ${tool.tone}35`,
                            borderRadius: 999,
                            color: tool.tone === gold ? "#806315" : tool.tone,
                            display: "flex",
                            fontSize: 9,
                            fontWeight: 790,
                            gap: 5,
                            minHeight: 26,
                            opacity: 0.35 + active * 0.65,
                            padding: "0 9px",
                          }}
                        >
                          <span
                            style={{
                              background: tool.tone,
                              borderRadius: 999,
                              height: 5,
                              width: 5,
                            }}
                          />
                          {tool.label}
                        </div>
                      );
                    })}
                  </div>
                ) : null}

                {answer > 0 ? (
                  <Card
                    style={{
                      marginTop: 13,
                      opacity: answer,
                      padding: 15,
                      transform: `translateY(${interpolate(answer, [0, 1], [12, 0])}px)`,
                    }}
                  >
                    <div
                      style={{
                        alignItems: "center",
                        display: "flex",
                        justifyContent: "space-between",
                      }}
                    >
                      <strong style={{ fontSize: 14 }}>Assistant answer</strong>
                      <StatusPill tone="info">AI prepared</StatusPill>
                    </div>
                    <p
                      style={{
                        fontSize: 13,
                        lineHeight: 1.5,
                        margin: "10px 0 0",
                      }}
                    >
                      Priya Shah has one outstanding speaker task. Session
                      deliverables are counted separately. A personalised
                      reminder is ready to edit or queue.
                    </p>
                  </Card>
                ) : null}
              </div>

              <Card
                style={{ minHeight: 300, padding: 15, position: "relative" }}
              >
                <div style={{ fontSize: 13, fontWeight: 780, marginBottom: 9 }}>
                  Useful requests
                </div>
                <button
                  type="button"
                  style={{
                    background: interpolateColors(
                      requestChosen,
                      [0, 1],
                      ["transparent", "rgba(190,98,66,.07)"],
                    ),
                    border: 0,
                    borderBottom: `1px solid ${line}`,
                    borderTop: `1px solid ${line}`,
                    color: ink,
                    fontFamily: "inherit",
                    fontSize: 12,
                    fontWeight: 650,
                    lineHeight: 1.4,
                    padding: "13px 4px",
                    textAlign: "left",
                    width: "100%",
                  }}
                >
                  Find speakers with incomplete tasks and draft a personalised
                  reminder for my approval.
                </button>
                <div style={{ display: "grid", gap: 8, marginTop: 13 }}>
                  <div
                    style={{
                      alignItems: "center",
                      display: "flex",
                      justifyContent: "space-between",
                    }}
                  >
                    <strong style={{ fontSize: 12 }}>Source records</strong>
                    <StatusPill tone="info">
                      <ShieldCheck size={12} /> Event data
                    </StatusPill>
                  </div>
                  <div
                    style={{
                      alignItems: "center",
                      color: muted,
                      display: "flex",
                      flexDirection: "column",
                      inset: "118px 15px 15px",
                      justifyContent: "center",
                      opacity: 1 - evidenceReady,
                      pointerEvents: "none",
                      position: "absolute",
                      textAlign: "center",
                    }}
                  >
                    <ShieldCheck
                      color={PALETTE.sageDeep}
                      size={24}
                      strokeWidth={1.7}
                    />
                    <strong style={{ color: ink, fontSize: 12, marginTop: 9 }}>
                      Source records will appear here
                    </strong>
                    <span
                      style={{ fontSize: 10, lineHeight: 1.45, marginTop: 4 }}
                    >
                      Records appear when the event check completes.
                    </span>
                  </div>
                  <EvidenceCard
                    delay={0.43}
                    detail="1 incomplete speaker-scoped task"
                    label="Priya Shah"
                    progress={stage}
                  />
                  <EvidenceCard
                    delay={0.55}
                    detail="Published task reminder v1"
                    label="Speaker task reminder"
                    progress={stage}
                  />
                </div>
              </Card>
            </div>
          </div>
        </div>
        <FilmPointer
          x={pointerX}
          y={pointerY}
          opacity={interpolate(stage, [0.02, 0.09, 0.34], [0, 1, 0], CLAMP)}
          click={clickPulse(stage, 0.18)}
        />
      </AppShell>
    </AbsoluteFill>
  );
}

function ChangeRow({ after, label }: { after: string; label: string }) {
  return (
    <div
      style={{
        alignItems: "center",
        borderTop: `1px solid ${line}`,
        display: "grid",
        fontSize: 11,
        gridTemplateColumns: "112px 108px 1fr",
        minHeight: 40,
      }}
    >
      <strong>{label}</strong>
      <span style={{ color: muted }}>Not created</span>
      <span style={{ fontWeight: 690 }}>{after}</span>
    </div>
  );
}

function PreviewStage({ progress }: { progress: number }) {
  const stage = local(progress, 0.486, 0.785);
  const layerOpacity = stageVisible(progress, 0.486, 0.785);
  const reveal = ease(local(stage, 0, 0.16));
  const recipient = ease(local(stage, 0.24, 0.4));
  const checked = ease(local(stage, 0.62, 0.7));
  const approvalClick = clickPulse(stage, 0.83, 0.045);
  const pointerProgress = ease(local(stage, 0.5, 0.83));
  const pointerX = interpolate(pointerProgress, [0, 0.55, 1], [1100, 665, 774]);
  const pointerY = interpolate(pointerProgress, [0, 0.55, 1], [326, 670, 720]);
  return (
    <AbsoluteFill style={{ opacity: layerOpacity }}>
      <AppShell active="none" progress={progress}>
        <div style={{ height: "100%", padding: "23px 31px 25px" }}>
          <div
            style={{
              alignItems: "end",
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            <div>
              <div
                style={{
                  color: copperDeep,
                  fontSize: 10,
                  fontWeight: 840,
                  letterSpacing: ".11em",
                  textTransform: "uppercase",
                }}
              >
                Event Assistant · Write previews
              </div>
              <h1
                style={{
                  fontSize: 35,
                  letterSpacing: "-.04em",
                  lineHeight: 1,
                  margin: "8px 0 0",
                }}
              >
                Your assistant builds the action. You stay in control.
              </h1>
            </div>
            <StatusPill tone="good">1 action ready</StatusPill>
          </div>

          <Card
            style={{
              display: "flex",
              flexDirection: "column",
              marginTop: 16,
              minHeight: 605,
              opacity: reveal,
              overflow: "hidden",
              padding: "17px 19px 18px",
              transform: `translateY(${interpolate(reveal, [0, 1], [18, 0])}px)`,
            }}
          >
            <div
              style={{
                alignItems: "start",
                display: "flex",
                justifyContent: "space-between",
              }}
            >
              <div>
                <div
                  style={{
                    color: copperDeep,
                    fontSize: 9,
                    fontWeight: 850,
                    letterSpacing: ".1em",
                    textTransform: "uppercase",
                  }}
                >
                  Draft action
                </div>
                <h2
                  style={{
                    fontSize: 21,
                    letterSpacing: "-.025em",
                    margin: "6px 0 0",
                  }}
                >
                  Reminder for incomplete speaker tasks
                </h2>
                <p style={{ color: muted, fontSize: 12, margin: "7px 0 0" }}>
                  One personalised reminder · Priya Shah
                </p>
              </div>
              <StatusPill tone="good">Ready to approve</StatusPill>
            </div>

            <div
              style={{
                display: "grid",
                flex: 1,
                gap: 17,
                gridTemplateColumns: "1.05fr .95fr",
                marginTop: 15,
              }}
            >
              <div>
                <div
                  style={{
                    color: muted,
                    display: "grid",
                    fontSize: 10,
                    fontWeight: 780,
                    gridTemplateColumns: "112px 108px 1fr",
                    paddingBottom: 7,
                    textTransform: "uppercase",
                  }}
                >
                  <span>Change</span>
                  <span>Current</span>
                  <span>After approval</span>
                </div>
                <ChangeRow
                  after="Action needed: Upload presentation slides"
                  label="Subject"
                />
                <ChangeRow
                  after="1 deliverable · 0 suppressed · 0 invalid"
                  label="Audience"
                />
                <ChangeRow after="Program Cue" label="Sender" />
                <ChangeRow after="Reminder queued" label="Delivery" />
                <div
                  style={{
                    background: "rgba(212,167,44,.075)",
                    border: "1px solid rgba(212,167,44,.19)",
                    borderRadius: 9,
                    color: "#6f5a1d",
                    fontSize: 11,
                    lineHeight: 1.45,
                    marginTop: 10,
                    padding: "9px 11px",
                  }}
                >
                  One recipient. One clear action. Ready when you are.
                </div>
              </div>

              <div style={{ display: "grid", gap: 8 }}>
                <div
                  style={{
                    alignItems: "center",
                    display: "flex",
                    justifyContent: "space-between",
                  }}
                >
                  <strong style={{ fontSize: 13 }}>Reminder preview</strong>
                  <StatusPill tone="info">PERSONALISED · TASK-AWARE</StatusPill>
                </div>
                <div
                  style={{
                    background: "rgba(24,37,34,.025)",
                    border: `1px solid ${line}`,
                    borderRadius: 10,
                    display: "grid",
                    fontSize: 11,
                    gap: 7,
                    gridTemplateColumns: "104px 1fr",
                    padding: "10px 12px",
                  }}
                >
                  <span style={{ color: muted }}>Template version</span>
                  <strong>Assistant reminder · v1</strong>
                  <span style={{ color: muted }}>Sender</span>
                  <strong>Program Cue</strong>
                </div>
                <div
                  style={{
                    display: "grid",
                    fontSize: 11,
                    gap: 7,
                  }}
                >
                  <strong>Subject</strong>
                  <div
                    style={{
                      background: "#fff",
                      border: `1px solid ${line}`,
                      borderRadius: 8,
                      fontFamily: "ui-monospace, monospace",
                      padding: "8px 10px",
                    }}
                  >
                    Action needed: Upload presentation slides
                  </div>
                  <strong>Message template</strong>
                  <div
                    style={{
                      background: "#fff",
                      border: `1px solid ${line}`,
                      borderRadius: 8,
                      lineHeight: 1.4,
                      minHeight: 56,
                      padding: "9px 10px",
                    }}
                  >
                    Hi Priya, your next speaker task is “Upload presentation
                    slides.” Please complete it in your workspace before event
                    handoff.
                  </div>
                  <span style={{ color: muted, fontSize: 10, lineHeight: 1.4 }}>
                    Edits stay in draft. Recipient checks refresh before
                    approval.
                  </span>
                </div>
                <div
                  style={{
                    borderTop: `1px solid ${line}`,
                    opacity: recipient,
                    paddingTop: 8,
                    transform: `translateY(${interpolate(recipient, [0, 1], [8, 0])}px)`,
                  }}
                >
                  <div
                    style={{
                      alignItems: "center",
                      display: "flex",
                      justifyContent: "space-between",
                      marginBottom: 7,
                    }}
                  >
                    <strong style={{ fontSize: 12 }}>
                      Review 1 selected recipient
                    </strong>
                    <span style={{ color: muted, fontSize: 10 }}>
                      1 confirmed recipient
                    </span>
                  </div>
                  <div
                    style={{
                      background: "rgba(255,255,255,.72)",
                      border: `1px solid ${line}`,
                      borderRadius: 9,
                      display: "grid",
                      gridTemplateColumns: "126px 1fr 1.25fr",
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        color: muted,
                        fontSize: 9,
                        fontWeight: 780,
                        gridColumn: "1 / -1",
                        padding: "7px 10px",
                        textTransform: "uppercase",
                      }}
                    >
                      <span style={{ display: "inline-block", width: 126 }}>
                        Delivery state
                      </span>
                      <span style={{ display: "inline-block", width: 156 }}>
                        Recipient
                      </span>
                      <span>Address</span>
                    </div>
                    <div style={{ padding: "9px 10px" }}>
                      <StatusPill tone="good">Deliverable</StatusPill>
                    </div>
                    <strong style={{ fontSize: 11, padding: "13px 10px" }}>
                      Priya Shah
                    </strong>
                    <span
                      style={{
                        color: muted,
                        fontSize: 10,
                        padding: "13px 10px",
                      }}
                    >
                      priya.speaker@example.com
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <div
              style={{
                alignItems: "center",
                borderTop: `1px solid ${line}`,
                display: "flex",
                justifyContent: "space-between",
                marginTop: 13,
                paddingTop: 12,
              }}
            >
              <div
                style={{
                  alignItems: "center",
                  display: "flex",
                  fontSize: 11,
                  gap: 9,
                  maxWidth: 720,
                }}
              >
                <span
                  style={{
                    alignItems: "center",
                    background: checked ? ink : paper,
                    border: `1px solid ${checked ? ink : "rgba(24,37,34,.28)"}`,
                    borderRadius: 4,
                    color: paper,
                    display: "flex",
                    height: 18,
                    justifyContent: "center",
                    width: 18,
                  }}
                >
                  {checked > 0.5 ? <Check size={13} strokeWidth={3} /> : null}
                </span>
                Reminder and recipient confirmed.
              </div>
              <AppButton primary pressed={approvalClick > 0.35}>
                <Send size={14} /> Approve and queue reminder
              </AppButton>
            </div>
          </Card>
        </div>
        <FilmPointer
          x={pointerX}
          y={pointerY}
          opacity={interpolate(stage, [0.48, 0.55, 0.94], [0, 1, 1], CLAMP)}
          click={Math.max(clickPulse(stage, 0.67), approvalClick)}
        />
      </AppShell>
    </AbsoluteFill>
  );
}

function AuditItem({
  action,
  actor,
  delay,
  progress,
  tone,
}: {
  action: string;
  actor: string;
  delay: number;
  progress: number;
  tone: string;
}) {
  const reveal = ease(local(progress, delay, delay + 0.16));
  return (
    <li
      style={{
        display: "grid",
        gridTemplateColumns: "16px 1fr",
        listStyle: "none",
        opacity: reveal,
        position: "relative",
        transform: `translateY(${interpolate(reveal, [0, 1], [9, 0])}px)`,
      }}
    >
      <span
        style={{
          background: tone,
          border: `3px solid ${paper}`,
          borderRadius: 999,
          boxShadow: `0 0 0 1px ${tone}55`,
          height: 10,
          marginTop: 3,
          width: 10,
          zIndex: 2,
        }}
      />
      <div style={{ paddingBottom: 15 }}>
        <strong style={{ fontSize: 12 }}>{action}</strong>
        <div style={{ color: muted, fontSize: 9, marginTop: 4 }}>{actor}</div>
      </div>
    </li>
  );
}

function ResultStage({ progress }: { progress: number }) {
  const stage = local(progress, 0.785, 1);
  const layerOpacity = stageVisible(progress, 0.785, 1.001);
  const success = ease(local(stage, 0, 0.16));
  const operation = ease(local(stage, 0.22, 0.38));
  const pointerMove = ease(local(stage, 0.05, 0.24));
  const cursorOpacity = interpolate(
    stage,
    [0.02, 0.08, 0.34],
    [0, 1, 0],
    CLAMP,
  );
  return (
    <AbsoluteFill style={{ opacity: layerOpacity }}>
      <AppShell
        active={operation > 0.5 ? "operations" : "none"}
        progress={progress}
      >
        <div
          style={{
            inset: 0,
            opacity: 1 - operation,
            padding: "24px 31px",
            position: "absolute",
            transform: `translateX(${interpolate(operation, [0, 1], [0, -24])}px)`,
          }}
        >
          <div
            style={{
              color: copperDeep,
              fontSize: 10,
              fontWeight: 840,
              letterSpacing: ".11em",
              textTransform: "uppercase",
            }}
          >
            Event Assistant · Write previews
          </div>
          <h1
            style={{
              fontSize: 37,
              letterSpacing: "-.045em",
              lineHeight: 1,
              margin: "8px 0 0",
            }}
          >
            Approved result
          </h1>
          <div
            style={{
              alignItems: "center",
              background: "rgba(143,191,154,.11)",
              border: "1px solid rgba(58,95,66,.22)",
              borderRadius: 12,
              display: "flex",
              fontSize: 12,
              gap: 10,
              marginTop: 20,
              minHeight: 51,
              opacity: success,
              padding: "0 15px",
              transform: `translateY(${interpolate(success, [0, 1], [12, 0])}px)`,
            }}
          >
            <CheckCircle2 color={PALETTE.sageDeep} size={19} />
            <strong>Reminder approved, queued and recorded.</strong>
            <span style={{ color: muted, marginLeft: "auto" }}>
              Delivery status · queued
            </span>
          </div>
          <Card
            style={{
              marginTop: 17,
              opacity: success,
              padding: 19,
              transform: `translateY(${interpolate(success, [0, 1], [16, 0])}px)`,
            }}
          >
            <div
              style={{
                alignItems: "start",
                display: "flex",
                justifyContent: "space-between",
              }}
            >
              <div>
                <div
                  style={{
                    color: copperDeep,
                    fontSize: 9,
                    fontWeight: 840,
                    letterSpacing: ".1em",
                    textTransform: "uppercase",
                  }}
                >
                  Approved template · merge fields preserved
                </div>
                <h2 style={{ fontSize: 22, margin: "7px 0 0" }}>
                  Assistant reminder · version 1
                </h2>
                <div style={{ color: muted, fontSize: 11, marginTop: 6 }}>
                  Subject · Action needed: Upload presentation slides
                </div>
              </div>
              <div style={{ alignItems: "center", display: "flex", gap: 8 }}>
                <StatusPill tone="good">Draft action · Approved</StatusPill>
                <StatusPill tone="info">Delivery · Queued</StatusPill>
              </div>
            </div>
            <div
              style={{
                alignItems: "center",
                background: "rgba(24,37,34,.025)",
                border: `1px solid ${line}`,
                borderRadius: 10,
                display: "grid",
                gap: 12,
                gridTemplateColumns: "1fr auto",
                marginTop: 17,
                minHeight: 70,
                padding: "0 14px",
              }}
            >
              <div>
                <strong style={{ fontSize: 13 }}>Reminder queued</strong>
                <div style={{ color: muted, fontSize: 10, marginTop: 4 }}>
                  Approved by Jordan Alvarez · 1 recipient
                </div>
              </div>
              <AppButton primary small>
                <CheckCircle2 size={13} /> Open operation
              </AppButton>
            </div>
          </Card>
        </div>

        <div
          style={{
            inset: 0,
            opacity: operation,
            padding: "24px 31px 30px",
            position: "absolute",
            transform: `translateX(${interpolate(operation, [0, 1], [28, 0])}px)`,
          }}
        >
          <div
            style={{
              margin: "0 auto",
              transform: "scale(1.12)",
              transformOrigin: "50% 0",
              width: "89.3%",
            }}
          >
            <div
              style={{
                color: copperDeep,
                fontSize: 10,
                fontWeight: 840,
                letterSpacing: ".11em",
                textTransform: "uppercase",
              }}
            >
              Recent activity
            </div>
            <h1
              style={{
                fontSize: 38,
                letterSpacing: "-.045em",
                lineHeight: 1,
                margin: "8px 0 0",
              }}
            >
              Operation Centre
            </h1>
            <div
              style={{
                alignItems: "stretch",
                display: "grid",
                gap: 17,
                gridTemplateColumns: "1.02fr .98fr",
                marginTop: 19,
                minHeight: 340,
              }}
            >
              <div style={{ display: "flex", flexDirection: "column" }}>
                <div
                  style={{
                    alignItems: "center",
                    display: "flex",
                    justifyContent: "space-between",
                    marginBottom: 9,
                  }}
                >
                  <strong style={{ fontSize: 13 }}>
                    Background operations
                  </strong>
                  <span style={{ color: muted, fontSize: 10 }}>1 recent</span>
                </div>
                <Card style={{ overflow: "hidden" }}>
                  <div
                    style={{
                      alignItems: "center",
                      display: "grid",
                      gap: 12,
                      gridTemplateColumns: "auto 1fr auto",
                      minHeight: 84,
                      padding: "0 15px",
                    }}
                  >
                    <StatusPill tone="info">Queued</StatusPill>
                    <div>
                      <strong style={{ fontSize: 14 }}>
                        Communication send
                      </strong>
                      <div style={{ color: muted, fontSize: 10, marginTop: 5 }}>
                        Approved by Jordan Alvarez · 1 recipient · 0 / 1
                        processed
                      </div>
                    </div>
                    <ChevronRight color={muted} size={17} />
                  </div>
                  <div
                    style={{
                      background: "rgba(55,112,142,.065)",
                      borderTop: `1px solid ${line}`,
                      color: "#285d76",
                      fontSize: 10,
                      lineHeight: 1.45,
                      padding: "11px 15px",
                    }}
                  >
                    Recipients and delivery progress stay together in one
                    timeline.
                  </div>
                </Card>
                <div
                  style={{
                    display: "grid",
                    gap: 8,
                    gridTemplateColumns: "repeat(3,1fr)",
                    marginTop: 12,
                  }}
                >
                  {[
                    ["01", "Selected"],
                    ["01", "Queued"],
                    ["00", "Delivered"],
                  ].map(([value, label]) => (
                    <div
                      key={label}
                      style={{
                        background: "rgba(255,255,255,.6)",
                        border: `1px solid ${line}`,
                        borderRadius: 10,
                        padding: "10px 12px",
                      }}
                    >
                      <strong style={{ fontSize: 20, letterSpacing: "-.03em" }}>
                        {value}
                      </strong>
                      <div style={{ color: muted, fontSize: 9, marginTop: 3 }}>
                        {label}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <Card style={{ minHeight: 340, padding: "16px 18px" }}>
                <div
                  style={{
                    alignItems: "center",
                    display: "flex",
                    justifyContent: "space-between",
                  }}
                >
                  <strong style={{ fontSize: 14 }}>Audit trail</strong>
                  <span style={{ color: muted, fontSize: 9 }}>
                    Related activity
                  </span>
                </div>
                <ol
                  style={{
                    borderLeft: `1px solid ${line}`,
                    margin: "16px 0 0 5px",
                    padding: "0 0 0 16px",
                  }}
                >
                  <AuditItem
                    action="assistant reminder · previewed"
                    actor="Program Cue assistant · preview saved"
                    delay={0.31}
                    progress={stage}
                    tone={copper}
                  />
                  <AuditItem
                    action="communication · queued"
                    actor="Jordan Alvarez · approved"
                    delay={0.45}
                    progress={stage}
                    tone="#37708e"
                  />
                  <AuditItem
                    action="assistant reminder · approval recorded"
                    actor="Jordan Alvarez · approval confirmed"
                    delay={0.59}
                    progress={stage}
                    tone={sage}
                  />
                </ol>
                <div
                  style={{
                    alignItems: "center",
                    background: "rgba(143,191,154,.08)",
                    border: "1px solid rgba(58,95,66,.18)",
                    borderRadius: 10,
                    color: PALETTE.sageDeep,
                    display: "flex",
                    fontSize: 10,
                    fontWeight: 740,
                    gap: 8,
                    marginTop: 4,
                    minHeight: 38,
                    padding: "0 11px",
                  }}
                >
                  <ShieldCheck size={15} /> Approval and results remain
                  connected.
                </div>
              </Card>
            </div>
            <Card
              style={{
                marginTop: 14,
                minHeight: 126,
                padding: "14px 18px 16px",
              }}
            >
              <div
                style={{
                  alignItems: "center",
                  display: "flex",
                  justifyContent: "space-between",
                }}
              >
                <strong style={{ fontSize: 13 }}>Delivery progress</strong>
                <span style={{ color: muted, fontSize: 10 }}>
                  Current delivery state
                </span>
              </div>
              <div
                style={{
                  display: "grid",
                  gap: 9,
                  gridTemplateColumns: "repeat(4,1fr)",
                  marginTop: 11,
                }}
              >
                {[
                  ["01", "Audience confirmed", "1 recipient", "good"],
                  ["02", "Reminder queued", "Current state", "info"],
                  ["03", "Processing", "Up next", "neutral"],
                  ["04", "Delivery", "Pending", "neutral"],
                ].map(([number, label, detail, tone]) => (
                  <div
                    key={label}
                    style={{
                      alignItems: "center",
                      background:
                        tone === "good"
                          ? "rgba(143,191,154,.09)"
                          : tone === "info"
                            ? "rgba(55,112,142,.075)"
                            : "rgba(24,37,34,.025)",
                      border: `1px solid ${line}`,
                      borderRadius: 9,
                      display: "grid",
                      gap: 9,
                      gridTemplateColumns: "28px 1fr",
                      minHeight: 66,
                      padding: "0 10px",
                    }}
                  >
                    <span
                      style={{
                        color:
                          tone === "good"
                            ? PALETTE.sageDeep
                            : tone === "info"
                              ? "#285d76"
                              : muted,
                        fontSize: 10,
                        fontWeight: 840,
                      }}
                    >
                      {number}
                    </span>
                    <div>
                      <strong style={{ fontSize: 11 }}>{label}</strong>
                      <div style={{ color: muted, fontSize: 9, marginTop: 3 }}>
                        {detail}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </div>
        <FilmPointer
          x={interpolate(pointerMove, [0, 1], [1160, 1124])}
          y={interpolate(pointerMove, [0, 1], [364, 375])}
          opacity={cursorOpacity}
          click={clickPulse(stage, 0.23)}
        />
      </AppShell>
    </AbsoluteFill>
  );
}

export function AssistScene({ duration }: AssistSceneProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = duration <= 1 ? 1 : clamp(frame / (duration - 1));
  const entrance = spring({
    frame,
    fps,
    config: { damping: 180, stiffness: 110, mass: 0.82 },
  });
  const exit = interpolate(progress, [0.975, 1], [1, 0], CLAMP);
  const browserScale = interpolate(ease(progress), [0, 1], [0.992, 1.007]);
  const route =
    progress < 0.205
      ? "app.programcue.com/admin/command"
      : progress < 0.845
        ? "app.programcue.com/admin/assistant"
        : "app.programcue.com/admin/operations";
  return (
    <AbsoluteFill
      style={{
        background: deep,
        fontFamily:
          "Program Cue Inter, Inter, ui-sans-serif, system-ui, sans-serif",
        overflow: "hidden",
      }}
    >
      <SubtleGrid color="rgba(255,253,248,.11)" opacity={0.24} size={42} />
      <div
        style={{
          background:
            "radial-gradient(circle at 14% 32%, rgba(143,191,154,.17), transparent 30%), radial-gradient(circle at 88% 74%, rgba(190,98,66,.2), transparent 34%)",
          inset: 0,
          position: "absolute",
        }}
      />
      <div
        style={{
          left: 120,
          opacity: entrance * exit,
          position: "absolute",
          top: 76,
          transform: `translate3d(0, ${interpolate(entrance, [0, 1], [24, 0])}px, 0) scale(${browserScale})`,
          transformOrigin: "50% 60%",
        }}
      >
        <BrowserFrame
          darkChrome
          height={888}
          motion="static"
          radius={22}
          title="Program Cue"
          url={route}
          width={1680}
        >
          <CommandCentreStage progress={progress} />
          <AssistantStage progress={progress} />
          <PreviewStage progress={progress} />
          <ResultStage progress={progress} />
        </BrowserFrame>
      </div>
      <SubtleGrain id="assist-scene-grain" opacity={0.045} seed={29} />
    </AbsoluteFill>
  );
}
