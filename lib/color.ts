/**
 * Minimal CSS colour parsing — just enough to compare colours, measure
 * luminance, and emit a consistent representation in the brand kit.
 */

export type Rgb = { r: number; g: number; b: number; a: number };

/** The named colours that actually turn up in real stylesheets. */
const NAMED: Record<string, string> = {
  black: "#000000", white: "#ffffff", red: "#ff0000", lime: "#00ff00", blue: "#0000ff",
  yellow: "#ffff00", cyan: "#00ffff", aqua: "#00ffff", magenta: "#ff00ff", fuchsia: "#ff00ff",
  silver: "#c0c0c0", gray: "#808080", grey: "#808080", maroon: "#800000", olive: "#808000",
  green: "#008000", purple: "#800080", teal: "#008080", navy: "#000080", orange: "#ffa500",
  pink: "#ffc0cb", brown: "#a52a2a", gold: "#ffd700", beige: "#f5f5dc", ivory: "#fffff0",
  khaki: "#f0e68c", salmon: "#fa8072", coral: "#ff7f50", crimson: "#dc143c", indigo: "#4b0082",
  violet: "#ee82ee", plum: "#dda0dd", orchid: "#da70d6", tan: "#d2b48c", wheat: "#f5deb3",
  snow: "#fffafa", azure: "#f0ffff", lavender: "#e6e6fa", linen: "#faf0e6", tomato: "#ff6347",
  turquoise: "#40e0d0", gainsboro: "#dcdcdc", whitesmoke: "#f5f5f5", lightgray: "#d3d3d3",
  lightgrey: "#d3d3d3", darkgray: "#a9a9a9", darkgrey: "#a9a9a9", dimgray: "#696969",
  dimgrey: "#696969", lightblue: "#add8e6", darkblue: "#00008b", lightgreen: "#90ee90",
  darkgreen: "#006400", darkred: "#8b0000", steelblue: "#4682b4", slategray: "#708090",
  slategrey: "#708090", royalblue: "#4169e1", skyblue: "#87ceeb", midnightblue: "#191970",
  rebeccapurple: "#663399", transparent: "#00000000",
};

/** Parse a CSS colour into RGBA, or null if it isn't a colour we understand. */
export function parseColor(input: string): Rgb | null {
  const value = input.trim().toLowerCase();
  if (!value) return null;

  const named = NAMED[value];
  if (named) return parseColor(named);

  if (value.startsWith("#")) return parseHex(value);
  if (value.startsWith("rgb")) return parseNumeric(value, "rgb");
  if (value.startsWith("hsl")) return parseNumeric(value, "hsl");
  if (value.startsWith("oklch")) return parseOklch(value);
  if (value.startsWith("oklab")) return parseLab(value, "oklab");
  if (value.startsWith("lab")) return parseLab(value, "lab");
  return null;
}

/** Split `fn(a b c / alpha)` or `fn(a, b, c, alpha)` into its numeric parts. */
function functionParts(value: string): string[] | null {
  const open = value.indexOf("(");
  if (open === -1 || !value.endsWith(")")) return null;
  const parts = value.slice(open + 1, -1).replace(/\//g, " ").split(/[\s,]+/).filter(Boolean);
  return parts.length >= 3 ? parts : null;
}

function parseHex(value: string): Rgb | null {
  const hex = value.slice(1);
  const expand = (s: string) => parseInt(s.length === 1 ? s + s : s, 16);
  if (hex.length === 3 || hex.length === 4) {
    return {
      r: expand(hex[0]), g: expand(hex[1]), b: expand(hex[2]),
      a: hex.length === 4 ? expand(hex[3]) / 255 : 1,
    };
  }
  if (hex.length === 6 || hex.length === 8) {
    if (!/^[0-9a-f]+$/.test(hex)) return null;
    return {
      r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16),
      a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
    };
  }
  return null;
}

/** Handles both comma and modern space/slash syntax: rgb(0 0 0 / 50%). */
function parseNumeric(value: string, kind: "rgb" | "hsl"): Rgb | null {
  const open = value.indexOf("(");
  if (open === -1 || !value.endsWith(")")) return null;
  const parts = value
    .slice(open + 1, -1)
    .replace(/\//g, " ")
    .split(/[\s,]+/)
    .filter(Boolean);
  if (parts.length < 3) return null;

  const alpha = parts.length > 3 ? toAlpha(parts[3]) : 1;
  if (kind === "rgb") {
    const [r, g, b] = parts.slice(0, 3).map((p) =>
      p.endsWith("%") ? clamp(Number.parseFloat(p) * 2.55, 0, 255) : clamp(Number.parseFloat(p), 0, 255),
    );
    if ([r, g, b].some(Number.isNaN)) return null;
    return { r, g, b, a: alpha };
  }

  const h = Number.parseFloat(parts[0]);
  const s = Number.parseFloat(parts[1]) / 100;
  const l = Number.parseFloat(parts[2]) / 100;
  if ([h, s, l].some(Number.isNaN)) return null;
  return { ...hslToRgb(h, clamp(s, 0, 1), clamp(l, 0, 1)), a: alpha };
}

/** oklch() is common in modern design systems, so it's worth converting properly. */
function parseOklch(value: string): Rgb | null {
  const parts = functionParts(value);
  if (!parts) return null;

  const L = parts[0].endsWith("%") ? Number.parseFloat(parts[0]) / 100 : Number.parseFloat(parts[0]);
  const C = parts[1].endsWith("%") ? (Number.parseFloat(parts[1]) / 100) * 0.4 : Number.parseFloat(parts[1]);
  const hDeg = Number.parseFloat(parts[2]);
  if ([L, C, hDeg].some(Number.isNaN)) return null;
  const alpha = parts.length > 3 ? toAlpha(parts[3]) : 1;

  // Polar oklch -> cartesian oklab, then the shared oklab conversion.
  const h = (hDeg * Math.PI) / 180;
  return { ...oklabToSrgb(L, C * Math.cos(h), C * Math.sin(h)), a: alpha };
}

/**
 * CIE Lab (D50, as CSS specifies) and Oklab. Both appear in modern stylesheets —
 * notably in `@supports` blocks that restate a palette in a wider gamut.
 */
function parseLab(value: string, kind: "lab" | "oklab"): Rgb | null {
  const parts = functionParts(value);
  if (!parts) return null;

  const maxL = kind === "lab" ? 100 : 1;
  const L = parts[0].endsWith("%") ? (Number.parseFloat(parts[0]) / 100) * maxL : Number.parseFloat(parts[0]);
  const aScale = kind === "lab" ? 125 : 0.4;
  const a = parts[1].endsWith("%") ? (Number.parseFloat(parts[1]) / 100) * aScale : Number.parseFloat(parts[1]);
  const b = parts[2].endsWith("%") ? (Number.parseFloat(parts[2]) / 100) * aScale : Number.parseFloat(parts[2]);
  if ([L, a, b].some(Number.isNaN)) return null;
  const alpha = parts.length > 3 ? toAlpha(parts[3]) : 1;

  if (kind === "oklab") return { ...oklabToSrgb(L, a, b), a: alpha };

  // CIE Lab -> XYZ (D50) -> linear sRGB (Bradford-adapted D50->D65 matrix).
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const invert = (t: number) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  const x = invert(fx) * 0.9642;
  const y = invert(fy) * 1.0;
  const z = invert(fz) * 0.8249;

  const lr = 3.1338561 * x - 1.6168667 * y - 0.4906146 * z;
  const lg = -0.9787684 * x + 1.9161415 * y + 0.033454 * z;
  const lb = 0.0719453 * x - 0.2289914 * y + 1.4052427 * z;
  return { r: gammaEncode(lr), g: gammaEncode(lg), b: gammaEncode(lb), a: alpha };
}

function oklabToSrgb(L: number, a: number, b: number): { r: number; g: number; b: number } {
  const l_ = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return {
    r: gammaEncode(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
    g: gammaEncode(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
    b: gammaEncode(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_),
  };
}

/** Linear-light channel to an 8-bit sRGB value. */
function gammaEncode(c: number): number {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.abs(c) ** (1 / 2.4) - 0.055;
  return clamp(Math.round(v * 255), 0, 255);
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x]
    : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

function toAlpha(part: string): number {
  const n = part.endsWith("%") ? Number.parseFloat(part) / 100 : Number.parseFloat(part);
  return Number.isNaN(n) ? 1 : clamp(n, 0, 1);
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Hex for opaque colours, rgba() when there's transparency to preserve. */
export function formatColor(color: Rgb): string {
  const hex = (n: number) => Math.round(n).toString(16).padStart(2, "0");
  if (color.a >= 1) return `#${hex(color.r)}${hex(color.g)}${hex(color.b)}`;
  return `rgba(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)}, ${Number(color.a.toFixed(3))})`;
}

/** Normalise a CSS colour to a canonical string, or null if unparseable. */
export function normalizeColor(input: string): string | null {
  const parsed = parseColor(input);
  return parsed ? formatColor(parsed) : null;
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function relativeLuminance(color: Rgb): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}
