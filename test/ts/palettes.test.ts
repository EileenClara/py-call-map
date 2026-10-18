import { describe, expect, it } from "vitest";
import {
  COLOR_SCHEMES,
  isColorScheme,
  resolvePalette,
  type ColorScheme,
  type ThemeKind,
} from "../../src/webview/palettes";

const FIXED: ColorScheme[] = ["vivid", "soft", "contrast"];
const THEMES: ThemeKind[] = ["light", "dark"];

describe("resolvePalette", () => {
  for (const scheme of FIXED) {
    for (const theme of THEMES) {
      it(`${scheme}/${theme} fills every token`, () => {
        const palette = resolvePalette(scheme, theme, () => {
          throw new Error("cssVar must not run for fixed schemes");
        });
        for (const [key, value] of Object.entries(palette)) {
          if (typeof value === "string") {
            expect(value, key).toMatch(/^#[0-9a-f]{6}$/i);
          } else {
            expect(value, key).toBeGreaterThan(0);
          }
        }
      });
    }
  }

  it("uses stronger strokes for high contrast", () => {
    const high = resolvePalette("contrast", "light", () => "#000000");
    const vivid = resolvePalette("vivid", "light", () => "#000000");
    expect(high.nodeBorderWidth).toBeGreaterThan(vivid.nodeBorderWidth);
    expect(high.entryBorderWidth).toBeGreaterThan(vivid.entryBorderWidth);
    expect(high.edgeWidth).toBeGreaterThan(vivid.edgeWidth);
    expect(high.cycleWidth).toBeGreaterThan(vivid.cycleWidth);
  });

  it("resolves the default scheme from VS Code variables", () => {
    const seen: string[] = [];
    const palette = resolvePalette("default", "light", (name, fallback) => {
      seen.push(name);
      return fallback;
    });
    expect(seen).toContain("--vscode-editor-background");
    expect(seen).toContain("--vscode-focusBorder");
    expect(palette.nodeFill).toBe("#252526");
  });
});

describe("isColorScheme", () => {
  it("accepts the four known schemes", () => {
    for (const scheme of ["default", "vivid", "soft", "contrast"]) {
      expect(isColorScheme(scheme)).toBe(true);
    }
  });

  it("rejects unknown values", () => {
    for (const value of ["", "blue", null, 1, undefined, {}]) {
      expect(isColorScheme(value)).toBe(false);
    }
  });
});

describe("COLOR_SCHEMES", () => {
  it("lists the four schemes in display order", () => {
    expect(COLOR_SCHEMES.map((scheme) => scheme.id)).toEqual([
      "default",
      "vivid",
      "soft",
      "contrast",
    ]);
  });
});
