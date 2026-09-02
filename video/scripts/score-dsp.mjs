const SINE_TABLE_SIZE = 8192;
const SINE_TABLE_MASK = SINE_TABLE_SIZE - 1;
const SINE_TABLE = new Float64Array(SINE_TABLE_SIZE);
for (let index = 0; index < SINE_TABLE_SIZE; index += 1) {
  SINE_TABLE[index] = Math.sin((index / SINE_TABLE_SIZE) * Math.PI * 2);
}

export const clamp01 = (value) => Math.max(0, Math.min(1, value));

export const smoothstep = (value) => {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
};

export const midiToFrequency = (midi) => 440 * 2 ** ((midi - 69) / 12);

export const tableSine = (phase) =>
  SINE_TABLE[((phase * SINE_TABLE_SIZE) | 0) & SINE_TABLE_MASK];

export const tableHarmonic = (phase, harmonic) =>
  SINE_TABLE[((phase * harmonic * SINE_TABLE_SIZE) | 0) & SINE_TABLE_MASK];

export const advancePhase = (phase, increment) => {
  const next = phase + increment;
  return next >= 1 ? next - Math.floor(next) : next;
};

export const db = (value) => 20 * Math.log10(Math.max(value, Number.EPSILON));

export const equalPowerPan = (pan) => {
  const angle = (clamp01((pan + 1) / 2) * Math.PI) / 2;
  return [Math.cos(angle), Math.sin(angle)];
};

// A deterministic, gentle bus stage. Static gain remains responsible for the
// final peak ceiling; this only reduces crest factor above the knee.
export const compressBusSample = (value) => {
  const sign = value < 0 ? -1 : 1;
  const magnitude = Math.abs(value);
  const threshold = 0.34;
  const knee = 0.1;
  const ratio = 3.5;
  const lower = threshold - knee / 2;
  const upper = threshold + knee / 2;
  if (magnitude <= lower) return value;
  if (magnitude >= upper) {
    return sign * (threshold + (magnitude - threshold) / ratio);
  }
  const proportion = (magnitude - lower) / knee;
  const compressed =
    magnitude +
    (threshold + (magnitude - threshold) / ratio - magnitude) *
      smoothstep(proportion);
  return sign * compressed;
};
