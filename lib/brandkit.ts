import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import postcss, { type Rule } from "postcss";
import { normalizeColor, parseColor, relativeLuminance } from "@/lib/color";
import type { PageBundle } from "@/lib/page";
import { resolveHref } from "@/lib/url";

/** Every field has a concrete value — an undetectable one falls back to a CSS initial. */
export type ButtonStyle = {
  background: string;
  textColor: string;
  borderColor: string;
  borderRadius: string;
  shadow: string;
};

export type BrandKit = {
  colorScheme: "light" | "dark";
  fonts: { family: string; role: "body" | "heading" }[];
  /** Never null: an underivable slot falls back to the theme default (see FALLBACK_*). */
  colors: {
    primary: string;
    secondary: string;
    tertiary: string;
    accent: string;
    background: string;
    textPrimary: string;
    textSecondary: string;
    link: string;
  };
  typography: {
    fontFamilies: { primary: string | null; heading: string | null };
    fontStacks: { heading: string[]; body: string[] };
    fontSizes: { h1: string | null; h2: string | null; body: string | null };
  };
  spacing: { baseUnit: number; borderRadius: string | null };
  components: { buttonPrimary: ButtonStyle; buttonSecondary: ButtonStyle };
  images: {
    logo: string | null;
    favicon: string | null;
    ogImage: string | null;
    logoHref: string | null;
    logoAlt: string | null;
  };
  brandName: string | null;
};

type StyleRule = {
  selectors: string[];
  decls: Map<string, string>;
  /** True when the rule sits inside @media/@supports, so it's a conditional override. */
  conditional: boolean;
};

/** Selectors that only apply while the user interacts — never the resting style. */
const INTERACTIVE = /:(hover|focus|focus-within|focus-visible|active|visited|target|disabled|checked)\b/;
const BUTTON_CLASS = /(^|[-_\s])(btn|button|cta)/i;
const BRANDY_CLASS = /(^|[-_\s.])(btn|button|cta|primary|accent|secondary)/i;
/** Classes that mark an element as ordinary navigation rather than a call to action. */
const NAV_LINK_CLASS = /(^|[-_\s])(nav|menu)[-_]?(link|item|entry)|(^|[-_\s])(menu|nav)(link|item)/i;
const ICON_SELECTOR = /(^|[\s>+~,.#])(svg|i)\b|icon|glyph|\bfa-/i;
const HERO_CLASS = /(^|[-_\s])(hero|banner|jumbotron|masthead|splash|intro)/i;
const NAVBAR_CLASS = /(^|[-_\s])(nav|navbar|header|topbar|masthead)/i;

/** Theme neutrals used wherever a colour can't be derived. */
const FALLBACK_LIGHT = "#ffffff";
const FALLBACK_DARK = "#000000";

/** CSS initial values, used so component fields are never null. */
const DEFAULT_BUTTON_BORDER = "transparent";
const DEFAULT_BUTTON_RADIUS = "0px";
const DEFAULT_BUTTON_SHADOW = "none";

/**
 * Derive a brand kit from a fetched page using pure code heuristics — selector
 * matching, declaration frequency and colour maths. Nothing here interprets meaning,
 * so anything that can't be read straight out of the CSS or markup stays null.
 */
export function deriveBrandKit(bundle: PageBundle): BrandKit {
  const $ = cheerio.load(bundle.html);
  const { rules, atRuleVars } = collectRules(bundle);
  const variables = collectVariables($, rules, atRuleVars);
  for (const rule of rules) {
    for (const [prop, value] of rule.decls) rule.decls.set(prop, resolveVars(value, variables));
  }

  const bodyStyle = computeStyle($, $("body").first(), rules);
  const htmlStyle = computeStyle($, $("html").first(), rules);
  const background =
    firstColor(bodyStyle, ["background-color", "background"]) ??
    firstColor(htmlStyle, ["background-color", "background"]);

  const { fonts, headingStack, bodyStack } = collectFonts(rules, $, bodyStyle);
  const buttons = findButtonElements($);

  const colorScheme = classifyScheme(background);
  // No colour slot is ever null: what can't be derived falls back to the theme's
  // neutral — white on a light page, black on a dark one.
  const fallback = colorScheme === "dark" ? FALLBACK_DARK : FALLBACK_LIGHT;
  const ranked = rankButtonColors(rules, $, buttons);

  return {
    colorScheme,
    fonts,
    colors: {
      primary: ranked[0] ?? fallback,
      secondary: ranked[1] ?? fallback,
      tertiary: deriveTertiary(rules, $, ranked.slice(0, 2)) ?? fallback,
      accent: deriveAccent($, rules, background) ?? fallback,
      background: background ?? fallback,
      textPrimary: textColorOf($, rules, firstNonEmpty($, "p")) ?? firstColor(bodyStyle, ["color"]) ?? fallback,
      textSecondary: textColorOf($, rules, firstNonEmpty($, "h2, h3, h4, h5, h6")) ?? fallback,
      link: deriveLinkColor($, rules) ?? fallback,
    },
    typography: {
      fontFamilies: { primary: bodyStack[0] ?? null, heading: headingStack[0] ?? null },
      fontStacks: { heading: headingStack, body: bodyStack },
      fontSizes: deriveFontSizes(rules, $),
    },
    spacing: {
      // Hardcoded: a spacing scale isn't reliably derivable from CSS alone. No declaration
      // states the base unit, and margin/padding values across a page reflect many unrelated
      // decisions, so a frequency count over them would be a guess dressed up as a measurement.
      baseUnit: 4,
      borderRadius: deriveBorderRadius(rules, $, buttons),
    },
    components: deriveComponents($, rules, buttons, fallback),
    images: deriveImages($, bundle.url),
    brandName: deriveBrandName($),
  };
}

/* ---------------------------------------------------------------- CSS model */

/**
 * Flatten every stylesheet and inline <style> block into an ordered rule list, plus any
 * custom properties declared directly inside an at-rule — Tailwind v4's `@theme` block
 * holds a site's design tokens there, and they'd otherwise be invisible to var() resolution.
 */
function collectRules(bundle: PageBundle): { rules: StyleRule[]; atRuleVars: Map<string, string> } {
  const rules: StyleRule[] = [];
  const atRuleVars = new Map<string, string>();
  const sheets = [...bundle.css.map((file) => file.content), ...bundle.inlineStyles];

  for (const sheet of sheets) {
    let root;
    try {
      root = postcss.parse(sheet);
    } catch {
      continue; // unparseable stylesheet — skip it rather than failing the whole kit
    }

    root.walkDecls((decl) => {
      if (!decl.prop.startsWith("--") || decl.parent?.type !== "atrule") return;
      if (!atRuleVars.has(decl.prop)) atRuleVars.set(decl.prop, decl.value.trim());
    });

    root.walkRules((rule: Rule) => {
      // An alternate colour theme would otherwise overwrite the page's default styling.
      if (hasAncestorAtRule(rule, /prefers-color-scheme|print/)) return;
      // @keyframes "selectors" are percentages, not element selectors.
      if (hasAncestorAtRule(rule, /keyframes/)) return;

      const decls = new Map<string, string>();
      rule.walkDecls((decl) => {
        decls.set(decl.prop.toLowerCase().trim(), decl.value.replace(/\s*!important\s*$/i, "").trim());
      });
      if (decls.size === 0) return;

      rules.push({
        selectors: rule.selectors.map((selector) => selector.trim()).filter(Boolean),
        decls,
        // @layer is deliberately not conditional: it always applies and only affects
        // cascade order, unlike @media/@supports which may not apply at all.
        conditional: hasAncestorAtRule(rule, /media|supports|container/),
      });
    });
  }

  return { rules, atRuleVars };
}

function hasAncestorAtRule(rule: Rule, pattern: RegExp): boolean {
  let node = rule.parent;
  while (node) {
    if (node.type === "atrule") {
      const atRule = node as unknown as { name: string; params: string };
      if (pattern.test(atRule.name) || pattern.test(atRule.params)) return true;
    }
    node = (node as { parent?: typeof node }).parent;
  }
  return false;
}

/**
 * Custom properties, so var() references in colour and font values can be resolved.
 *
 * A token is routinely declared several times, and picking the wrong declaration
 * silently yields the wrong palette, so definitions are ranked by how strong the
 * evidence is that they are the ones in effect:
 *
 *  - activeScope: the selector matches this document's own <html>/<body>, so it is
 *    demonstrably applied — a site shipping `[data-theme=dark]` alongside
 *    `[data-theme=light]` tells us which one it renders with.
 *  - global: declared on :root/html/body unconditionally.
 *  - conditionalGlobal: the same, but inside @media/@supports. Commonly a wider-gamut
 *    restatement of a palette that must not displace the base value.
 *  - inactiveScope: some other component or theme scope — a last resort, and there the
 *    first definition wins, since later ones are alternative themes, not overrides.
 */
const VAR_RANK = { inactiveScope: 0, conditionalGlobal: 1, global: 2, activeScope: 3 } as const;

function collectVariables(
  $: cheerio.CheerioAPI,
  rules: StyleRule[],
  atRuleVars: Map<string, string>,
): Map<string, string> {
  const variables = new Map<string, string>(atRuleVars);
  // At-rule tokens (Tailwind's @theme) seed the pool below every rule-based definition.
  const ranks = new Map<string, number>([...atRuleVars.keys()].map((name) => [name, -1]));

  const roots = [$("html").first(), $("body").first()].filter((element) => element.length > 0);
  const isActiveScope = (selectors: string[]) =>
    selectors.some((selector) => {
      const usable = sanitizeSelector(selector);
      if (!usable) return false;
      try {
        return roots.some((element) => element.is(usable));
      } catch {
        return false;
      }
    });

  for (const rule of rules) {
    const global = rule.selectors.some((selector) => /^(:root|html|body|\*)$/i.test(selector.trim()));
    const rank = global
      ? rule.conditional
        ? VAR_RANK.conditionalGlobal
        : VAR_RANK.global
      : isActiveScope(rule.selectors)
        ? VAR_RANK.activeScope
        : VAR_RANK.inactiveScope;

    for (const [prop, value] of rule.decls) {
      if (!prop.startsWith("--")) continue;
      const previous = ranks.get(prop);
      if (previous !== undefined) {
        if (rank < previous) continue;
        // Among inactive theme scopes the first definition stands; later ones are
        // sibling themes (light/glass/dark), not overrides of each other.
        if (rank === previous && rank === VAR_RANK.inactiveScope) continue;
      }
      variables.set(prop, value);
      ranks.set(prop, rank);
    }
  }
  return variables;
}

/** Substitute var(--name, fallback) references, with a depth cap for circular definitions. */
function resolveVars(value: string, variables: Map<string, string>, depth = 0): string {
  if (depth > 8 || !value.includes("var(")) return value;

  const pattern = /var\(\s*(--[\w-]+)\s*(?:,([^()]*(?:\([^()]*\)[^()]*)*))?\)/g;
  const resolved = value.replace(pattern, (match, name: string, fallback?: string) => {
    const found = variables.get(name);
    if (found !== undefined) return found;
    return fallback !== undefined ? fallback.trim() : match;
  });

  return resolved === value ? value : resolveVars(resolved, variables, depth + 1);
}

/**
 * Merge every rule whose selector matches the element, in source order, then the
 * element's own style attribute. This approximates the cascade by document order and
 * ignores specificity, which is close enough for picking a representative value.
 */
function computeStyle(
  $: cheerio.CheerioAPI,
  element: cheerio.Cheerio<AnyNode>,
  rules: StyleRule[],
): Map<string, string> {
  const style = new Map<string, string>();
  if (element.length === 0) return style;

  // Unconditional rules first, then @media overrides, mirroring source order.
  for (const conditional of [false, true]) {
    for (const rule of rules) {
      if (rule.conditional !== conditional) continue;
      if (!matches(element, rule.selectors)) continue;
      for (const [prop, value] of rule.decls) style.set(prop, value);
    }
  }

  for (const [prop, value] of parseInlineStyle(element.attr("style") ?? "")) style.set(prop, value);
  return style;
}

function matches(element: cheerio.Cheerio<AnyNode>, selectors: string[]): boolean {
  for (const selector of selectors) {
    const usable = sanitizeSelector(selector);
    if (!usable) continue;
    try {
      if (element.is(usable)) return true;
    } catch {
      continue; // selector syntax css-select can't handle — ignore this one
    }
  }
  return false;
}

/** Drop pseudo-elements and interaction states; keep the structural part of the selector. */
function sanitizeSelector(selector: string): string | null {
  if (!selector || selector.includes("::") || INTERACTIVE.test(selector)) return null;
  if (/^[>+~]/.test(selector)) return null; // nested-syntax fragment, no standalone meaning
  const cleaned = selector.replace(/:(link|any-link)\b/gi, "").trim();
  return cleaned || null;
}

function parseInlineStyle(style: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of style.split(";")) {
    const index = part.indexOf(":");
    if (index === -1) continue;
    const prop = part.slice(0, index).trim().toLowerCase();
    const value = part.slice(index + 1).replace(/\s*!important\s*$/i, "").trim();
    if (prop && value) out.set(prop, value);
  }
  return out;
}

/* ------------------------------------------------------------ value pickers */

/** First of the given properties whose value yields a colour. */
function firstColor(style: Map<string, string>, props: string[]): string | null {
  for (const prop of props) {
    const value = style.get(prop);
    if (!value) continue;
    const color = extractColor(value);
    if (color) return color;
  }
  return null;
}

/** Pull a colour out of a value that may be a shorthand (`1px solid #ccc`, `#fff url(x)`). */
function extractColor(value: string): string | null {
  const direct = normalizeColor(value);
  if (direct) return direct;
  const tokens = value.match(/#[0-9a-f]{3,8}\b|(?:rgba?|hsla?|oklch)\([^)]*\)|\b[a-z]+\b/gi) ?? [];
  for (const token of tokens) {
    const parsed = normalizeColor(token);
    if (parsed) return parsed;
  }
  return null;
}

function isVisibleColor(color: string | null): color is string {
  if (!color) return false;
  const parsed = parseColor(color);
  return parsed !== null && parsed.a > 0.05;
}

function classifyScheme(background: string | null): "light" | "dark" {
  const parsed = background ? parseColor(background) : null;
  // No parseable page background means the browser default, which is white.
  if (!parsed || parsed.a === 0) return "light";
  return relativeLuminance(parsed) < 0.4 ? "dark" : "light";
}

/* ------------------------------------------------------------------- fonts */

function splitFontStack(value: string): string[] {
  return splitTopLevel(value)
    .map((part) => part.trim().replace(/^["']|["']$/g, "").trim())
    .filter((part) => {
      if (part.length === 0) return false;
      if (/^(inherit|initial|unset|revert)$/i.test(part)) return false;
      // A var() that survived resolution names no real font — the definition lives
      // somewhere we can't see (a scoped rule, or set from JavaScript). Drop it
      // rather than reporting "var(--font-x)" as a font family.
      return !part.includes("var(") && !part.startsWith("--");
    });
}

function isHeadingSelector(selector: string): boolean {
  return /(^|[\s>+~,.#:[])h[1-6]\b/i.test(selector) || /\b(heading|headline|title)\b/i.test(selector);
}

function isBodySelector(selector: string): boolean {
  return /(^|[\s>+~,])(html|body|p|:root|\*|main|article|li|td|blockquote)(\s|$|,|\.|:|\[)/i.test(
    `${selector.trim()} `,
  );
}

/**
 * Collect font-family declarations and split them by the role their selector implies:
 * h1–h6 (or heading-ish class names) are headings, body/p/general text selectors are body.
 */
function collectFonts(
  rules: StyleRule[],
  $: cheerio.CheerioAPI,
  bodyStyle: Map<string, string>,
): { fonts: BrandKit["fonts"]; headingStack: string[]; bodyStack: string[] } {
  let headingStack: string[] = [];
  let bodyStack: string[] = [];
  const roleByFamily = new Map<string, "body" | "heading">();
  const casing = new Map<string, string>();

  for (const rule of rules) {
    const declared = rule.decls.get("font-family") ?? familyFromShorthand(rule.decls.get("font"));
    if (!declared) continue;
    const stack = splitFontStack(declared);
    if (stack.length === 0) continue;

    for (const selector of rule.selectors) {
      if (sanitizeSelector(selector) === null) continue;
      const role = isHeadingSelector(selector) ? "heading" : isBodySelector(selector) ? "body" : null;
      if (!role) continue;
      if (role === "heading" && headingStack.length === 0) headingStack = stack;
      if (role === "body" && bodyStack.length === 0) bodyStack = stack;
      for (const family of stack) {
        const key = family.toLowerCase();
        casing.set(key, family);
        if (!roleByFamily.has(key)) roleByFamily.set(key, role);
      }
    }
  }

  // Fallback for pages that only set fonts through class selectors (`.site-body`):
  // read the stack off the actual element instead of the selector scan.
  if (bodyStack.length === 0) {
    bodyStack = splitFontStack(bodyStyle.get("font-family") ?? familyFromShorthand(bodyStyle.get("font")) ?? "");
  }
  if (headingStack.length === 0) {
    const heading = $("h1").first().length > 0 ? $("h1").first() : $("h2").first();
    const style = computeStyle($, heading, rules);
    headingStack = splitFontStack(style.get("font-family") ?? familyFromShorthand(style.get("font")) ?? "");
  }

  for (const [stack, role] of [
    [headingStack, "heading"],
    [bodyStack, "body"],
  ] as const) {
    for (const family of stack) {
      const key = family.toLowerCase();
      casing.set(key, family);
      if (!roleByFamily.has(key)) roleByFamily.set(key, role);
    }
  }

  const fonts = [...roleByFamily.entries()].map(([key, role]) => ({ family: casing.get(key) ?? key, role }));
  return { fonts, headingStack, bodyStack };
}

/** `font: italic bold 16px/1.4 Georgia, serif` — everything after the size is the family. */
function familyFromShorthand(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(
    /(?:^|\s)(?:[\d.]+(?:px|rem|em|pt|%)|larger|smaller|medium)(?:\s*\/\s*\S+)?\s+(.+)$/i,
  );
  return match ? match[1] : undefined;
}

function deriveFontSizes(rules: StyleRule[], $: cheerio.CheerioAPI): BrandKit["typography"]["fontSizes"] {
  // First match wins, so the base rule beats any later responsive override.
  const firstSize = (test: (selector: string) => boolean): string | null => {
    for (const rule of rules) {
      if (rule.conditional) continue;
      const size = rule.decls.get("font-size");
      if (!size) continue;
      if (rule.selectors.some((selector) => sanitizeSelector(selector) !== null && test(selector))) {
        return size;
      }
    }
    return null;
  };

  const targets = (tag: string) => (selector: string) =>
    selector.split(/[\s>+~]/).pop()?.trim().toLowerCase() === tag;

  return {
    h1: firstSize(targets("h1")) ?? sizeFromElement($, rules, "h1"),
    h2: firstSize(targets("h2")) ?? sizeFromElement($, rules, "h2"),
    body: firstSize((selector) => /^(body|p|html|:root)$/i.test(selector.trim())) ?? sizeFromElement($, rules, "body"),
  };
}

function sizeFromElement($: cheerio.CheerioAPI, rules: StyleRule[], tag: string): string | null {
  const element = $(tag).first();
  if (element.length === 0) return null;
  return computeStyle($, element, rules).get("font-size") ?? null;
}

function deriveLinkColor($: cheerio.CheerioAPI, rules: StyleRule[]): string | null {
  // sanitizeSelector normalises `a:link` to `a`, so both forms are covered here.
  const anchor = $("a[href]").first();
  if (anchor.length > 0) {
    const color = firstColor(computeStyle($, anchor, rules), ["color"]);
    if (color) return color;
  }
  for (const rule of rules) {
    if (!rule.selectors.some((selector) => /^a$/i.test(selector.trim()))) continue;
    const color = firstColor(rule.decls, ["color"]);
    if (color) return color;
  }
  return null;
}

/* ---------------------------------------------------------- brand colours */

function findButtonElements($: cheerio.CheerioAPI): cheerio.Cheerio<AnyNode>[] {
  const found: cheerio.Cheerio<AnyNode>[] = [];
  const push = (el: Element) => {
    if (found.length < 40) found.push($(el));
  };

  $("button, input[type='submit'], input[type='button'], [role='button']").each((_, el) =>
    push(el as Element),
  );
  $("[class]").each((_, el) => {
    if (BUTTON_CLASS.test($(el).attr("class") ?? "")) push(el as Element);
  });

  return found;
}

/**
 * Frequency heuristic, not semantic classification: the background colour appearing on the
 * most button-like rules and elements becomes "primary", the next distinct one "secondary",
 * then "accent". Nothing here knows which colour a designer would call the brand colour —
 * only which one is repeated most often across buttons and CTAs.
 */
function rankButtonColors(
  rules: StyleRule[],
  $: cheerio.CheerioAPI,
  buttons: cheerio.Cheerio<AnyNode>[],
): string[] {
  const counts = new Map<string, number>();
  const bump = (color: string | null) => {
    if (!isVisibleColor(color)) return;
    counts.set(color, (counts.get(color) ?? 0) + 1);
  };

  for (const rule of rules) {
    if (!rule.selectors.some((selector) => sanitizeSelector(selector) !== null && isButtonSelector(selector))) {
      continue;
    }
    bump(firstColor(rule.decls, ["background-color", "background"]));
  }
  for (const button of buttons) {
    bump(firstColor(computeStyle($, button, rules), ["background-color", "background"]));
  }

  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([color]) => color);
}

/**
 * A third brand colour drawn from icons and button hover states — the places a palette
 * tends to show a colour that never appears as a resting button background. Ranked by
 * frequency, and only accepted if it differs from primary and secondary.
 */
function deriveTertiary(
  rules: StyleRule[],
  $: cheerio.CheerioAPI,
  taken: string[],
): string | null {
  const counts = new Map<string, number>();
  const bump = (color: string | null) => {
    if (!isVisibleColor(color) || taken.includes(color)) return;
    counts.set(color, (counts.get(color) ?? 0) + 1);
  };

  for (const rule of rules) {
    const usable = rule.selectors.filter((selector) => !selector.includes("::"));
    if (usable.length === 0) continue;

    // Hover styling on a button: the colour it changes to.
    if (usable.some((selector) => /:hover\b/.test(selector) && isButtonSelector(selector))) {
      bump(firstColor(rule.decls, ["background-color", "background"]));
      bump(firstColor(rule.decls, ["color"]));
    }

    // Icon styling: fill/stroke carry the colour far more often than `color` does.
    if (usable.some((selector) => ICON_SELECTOR.test(selector))) {
      bump(firstColor(rule.decls, ["fill", "stroke", "color"]));
    }
  }

  // Icons drawn inline carry their colour as an attribute rather than a declaration.
  $("svg, svg *").each((_, el) => {
    for (const attribute of ["fill", "stroke"]) {
      const value = $(el).attr(attribute);
      if (!value || /^(none|currentcolor|inherit)$/i.test(value)) continue;
      bump(normalizeColor(value));
    }
  });

  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/**
 * The call-to-action colour: the background of a button in the navbar that isn't part
 * of the navigation (a "Sign up" / "Get started"), falling back to the first button in
 * the hero section.
 *
 * What separates a CTA from a menu entry is that it's filled: nav links are bare text,
 * while the CTA carries its own background. So candidacy is decided by the computed
 * background rather than by class naming — sites style anchors as buttons with utility
 * classes that contain no hint of the word "button".
 */
function deriveAccent(
  $: cheerio.CheerioAPI,
  rules: StyleRule[],
  pageBackground: string | null,
): string | null {
  for (const candidates of [navbarCtaButtons($), heroButtons($)]) {
    for (const element of candidates) {
      const background = firstColor(computeStyle($, element, rules), ["background-color", "background"]);
      if (!isVisibleColor(background)) continue;
      // Matching the page background means it isn't filled — it just sits on the page.
      if (pageBackground && background === pageBackground) continue;
      return background;
    }
  }
  return null;
}

const CLICKABLE = "button, a, [role='button'], input[type='submit'], input[type='button']";

/** Clickable elements in the header/nav, minus the ones that are plainly menu entries. */
function navbarCtaButtons($: cheerio.CheerioAPI): cheerio.Cheerio<AnyNode>[] {
  const bars = $("nav, header, [role='navigation']").add(
    $("[class]").filter((_, el) => NAVBAR_CLASS.test($(el).attr("class") ?? "")),
  );

  const found: cheerio.Cheerio<AnyNode>[] = [];
  const seen = new Set<AnyNode>();

  bars.each((_, bar) => {
    $(bar)
      .find(CLICKABLE)
      .each((__, el) => {
        const element = $(el);
        if (seen.has(el)) return; // nested nav/header elements overlap
        // A class that names itself a menu entry is navigation, whatever it looks like.
        if (NAV_LINK_CLASS.test(element.attr("class") ?? "")) return;
        seen.add(el);
        found.push(element);
      });
  });
  return found;
}

/** Clickable elements inside the hero: an explicitly hero-classed block, else the h1's container. */
function heroButtons($: cheerio.CheerioAPI): cheerio.Cheerio<AnyNode>[] {
  let hero: cheerio.Cheerio<AnyNode> = $("[class]")
    .filter((_, el) => HERO_CLASS.test($(el).attr("class") ?? ""))
    .first();

  if (hero.length === 0) {
    const h1 = $("h1").first();
    if (h1.length > 0) hero = h1.closest("section, header, div");
  }
  if (hero.length === 0) return [];

  const found: cheerio.Cheerio<AnyNode>[] = [];
  hero.find(CLICKABLE).each((_, el) => {
    found.push($(el));
  });
  return found;
}

/** First element matching the selector that actually has visible text. */
function firstNonEmpty($: cheerio.CheerioAPI, selector: string): cheerio.Cheerio<AnyNode> | null {
  const matched = $(selector).filter((_, el) => $(el).text().trim().length > 0);
  return matched.length > 0 ? matched.first() : null;
}

function textColorOf(
  $: cheerio.CheerioAPI,
  rules: StyleRule[],
  element: cheerio.Cheerio<AnyNode> | null,
): string | null {
  if (!element) return null;
  // Text colour inherits, so walk up until an ancestor actually declares one.
  let current = element;
  for (let depth = 0; depth < 6 && current.length > 0; depth++) {
    const color = firstColor(computeStyle($, current, rules), ["color"]);
    if (isVisibleColor(color)) return color;
    current = current.parent();
  }
  return null;
}

function isButtonSelector(selector: string): boolean {
  return /(^|[\s>+~,])button\b/i.test(selector) || BRANDY_CLASS.test(selector);
}

function deriveBorderRadius(
  rules: StyleRule[],
  $: cheerio.CheerioAPI,
  buttons: cheerio.Cheerio<AnyNode>[],
): string | null {
  const counts = new Map<string, number>();
  const bump = (value: string | undefined) => {
    const radius = value?.trim();
    if (!radius || /^0(px|rem|em|%)?$/.test(radius)) return;
    counts.set(radius, (counts.get(radius) ?? 0) + 1);
  };

  for (const rule of rules) {
    if (!rule.selectors.some((selector) => sanitizeSelector(selector) !== null && isButtonSelector(selector))) {
      continue;
    }
    bump(rule.decls.get("border-radius"));
  }
  for (const button of buttons) bump(computeStyle($, button, rules).get("border-radius"));

  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/* ------------------------------------------------------------- components */

function deriveComponents(
  $: cheerio.CheerioAPI,
  rules: StyleRule[],
  buttons: cheerio.Cheerio<AnyNode>[],
  fallback: string,
): BrandKit["components"] {
  const styles: ButtonStyle[] = [];
  const seen = new Set<string>();

  for (const button of buttons) {
    const style = toButtonStyle(computeStyle($, button, rules), fallback);
    if (!style) continue;
    const signature = JSON.stringify(style);
    if (seen.has(signature)) continue; // visually identical — not a distinct button
    seen.add(signature);
    styles.push(style);
    if (styles.length === 2) break;
  }

  // A page with no buttons still gets fully-populated components rather than nulls.
  const blank = defaultButtonStyle(fallback);
  return { buttonPrimary: styles[0] ?? blank, buttonSecondary: styles[1] ?? blank };
}

function defaultButtonStyle(fallback: string): ButtonStyle {
  return {
    background: fallback,
    textColor: fallback,
    borderColor: DEFAULT_BUTTON_BORDER,
    borderRadius: DEFAULT_BUTTON_RADIUS,
    shadow: DEFAULT_BUTTON_SHADOW,
  };
}

/**
 * Read a button's style, substituting CSS initial values for anything absent so no
 * field is ever null: no border reads as "transparent", no rounding as "0px", and
 * no shadow as "none". A fully transparent colour describes nothing, so it counts
 * as absent rather than being reported as "rgba(0, 0, 0, 0)".
 */
function toButtonStyle(style: Map<string, string>, fallback: string): ButtonStyle | null {
  const opaque = (color: string | null) => (isVisibleColor(color) ? color : null);

  const derived = {
    background: opaque(firstColor(style, ["background-color", "background"])),
    textColor: opaque(firstColor(style, ["color"])),
    borderColor: opaque(firstColor(style, ["border-color", "border-top-color", "border"])),
    borderRadius: style.get("border-radius")?.trim() ?? null,
    shadow: normalizeShadow(style.get("box-shadow")),
  };
  // An element we derived nothing for isn't a button worth reporting.
  if (Object.values(derived).every((value) => value === null)) return null;

  return {
    background: derived.background ?? fallback,
    textColor: derived.textColor ?? fallback,
    borderColor: derived.borderColor ?? DEFAULT_BUTTON_BORDER,
    borderRadius: derived.borderRadius ?? DEFAULT_BUTTON_RADIUS,
    shadow: derived.shadow ?? DEFAULT_BUTTON_SHADOW,
  };
}

/**
 * Report a shadow only if it actually draws something. Utility frameworks leave
 * placeholder layers like `0 0 #0000` in the computed value, which render nothing.
 */
function normalizeShadow(value: string | undefined): string | null {
  const shadow = value?.trim();
  if (!shadow || /^none$/i.test(shadow)) return null;
  return splitTopLevel(shadow).every(isNoopShadowLayer) ? null : shadow;
}

function isNoopShadowLayer(layer: string): boolean {
  const rest = layer
    .replace(/#0000(?:0000)?\b|transparent|rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/gi, " ")
    .replace(/(^|\s)0(px|rem|em|%)?(?=\s|$)/g, " ")
    .replace(/\binset\b/gi, " ")
    .trim();
  return rest === "";
}

/** Split on commas that aren't inside parentheses, so rgba(...) stays intact. */
function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/* ----------------------------------------------------------------- images */

function deriveImages($: cheerio.CheerioAPI, baseUrl: string): BrandKit["images"] {
  const base = resolveHref($("base[href]").first().attr("href") ?? "", baseUrl) ?? baseUrl;
  const logo = findLogo($);

  const favicon = $("link")
    .filter((_, el) => {
      const rel = ($(el).attr("rel") ?? "").toLowerCase().split(/\s+/);
      return rel.includes("icon") || rel.includes("shortcut");
    })
    .first();

  const logoSrc = logo?.attr("src") ?? logo?.attr("data-src") ?? "";
  const logoHref = logo?.closest("a[href]").attr("href");
  const logoAlt = logo?.attr("alt")?.trim();

  return {
    logo: logoSrc ? resolveHref(logoSrc, base) : null,
    favicon: resolveHref(favicon.attr("href") ?? "", base),
    ogImage: resolveHref($("meta[property='og:image']").first().attr("content") ?? "", base),
    logoHref: logoHref ? resolveHref(logoHref, base) : null,
    logoAlt: logoAlt ? logoAlt : null,
  };
}

const CHROME_IMG = "header img, nav img, [class*='header'] img, [class*='navbar'] img";

function findLogo($: cheerio.CheerioAPI): cheerio.Cheerio<AnyNode> | null {
  const hinted = (scope: string) =>
    $(scope).filter((_, el) => {
      const image = $(el);
      const haystack = [image.attr("alt"), image.attr("src"), image.attr("class"), image.attr("id")]
        .filter(Boolean)
        .join(" ");
      return /logo|brand|wordmark/i.test(haystack);
    });

  // Position first: a logo-hinted image in the page header or nav is the strongest signal.
  // Searching the whole document first would happily return a customer logo from a
  // "trusted by" strip, since those filenames contain "logo" too.
  const inChrome = hinted(CHROME_IMG);
  if (inChrome.length > 0) return inChrome.first();

  const anyChrome = $(CHROME_IMG).first();
  if (anyChrome.length > 0) return anyChrome;

  // Last resort — a hinted image anywhere. Pages whose real logo is inline SVG rather
  // than an <img> can land on an unrelated logo here; that's the limit of the heuristic.
  const anywhere = hinted("img");
  return anywhere.length > 0 ? anywhere.first() : null;
}

function deriveBrandName($: cheerio.CheerioAPI): string | null {
  const siteName = $("meta[property='og:site_name']").first().attr("content")?.trim();
  if (siteName) return siteName;

  const title = $("title").first().text().trim();
  if (title) return title;

  const logoAlt = findLogo($)?.attr("alt")?.trim();
  return logoAlt ? logoAlt : null;
}
