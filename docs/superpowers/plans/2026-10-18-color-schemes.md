# Selectable Graph Color Schemes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a toolbar dropdown with four graph color schemes (Default, Vivid, Soft, High contrast), each with light and dark variants, persisted across windows.

**Architecture:** A pure `src/webview/palettes.ts` module resolves a `Palette` from a scheme id, theme kind, and a CSS-variable reader. The webview applies the palette to the cytoscape stylesheet and the canvas background. The extension stores the choice in `context.globalState` and sends it to the webview on `ready`.

**Tech Stack:** TypeScript, cytoscape, VS Code Webview API, Vitest.

## Global Constraints

- Version for this work: `0.3.0`.
- The `default` scheme must keep resolving all colors from `--vscode-*` variables; only stroke widths change (node 1.5, entry 2.5, edge 1.5, cycle 1.5).
- Only the `#canvas` background is palette-driven. Toolbar, banner, overlay, and tooltip keep VS Code theme variables.
- Do not add `contributes.configuration` entries. Persistence uses `context.globalState` key `pyCallMap.colorScheme`.
- Run every command from the repo root `E:\me\插件`.

## Pre-flight (controller, before Task 1)

The working tree has the unpublished 0.2.4 release changes. Commit them before branching.

```powershell
Set-Location "E:\me\插件"
git add examples/demo.py
git commit -m "fix: make the example runnable without data.txt"
git add README.md CHANGELOG.md package.json package-lock.json
git commit -m "chore: release 0.2.4"
git add docs/superpowers/plans/2026-10-18-color-schemes.md
git commit -m "docs: add color schemes implementation plan"
git checkout -b feat/color-schemes
```

Expected: `git status --short` prints nothing.

---

### Task 1: Palette module

**Files:**
- Create: `src/webview/palettes.ts`
- Test: `src/webview/palettes.test.ts`

**Interfaces:**
- Produces: `ColorScheme`, `ThemeKind`, `Palette`, `COLOR_SCHEMES`,
  `isColorScheme(value: unknown): value is ColorScheme`,
  `resolvePalette(scheme, theme, cssVar): Palette`.
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

Create `src/webview/palettes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  COLOR_SCHEMES,
  isColorScheme,
  resolvePalette,
  type ColorScheme,
  type ThemeKind,
} from "./palettes";

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
```

- [ ] **Step 2: Run the test and confirm it fails**

```powershell
npx vitest run src/webview/palettes.test.ts
```

Expected: FAIL with `Failed to resolve import "./palettes"`.

- [ ] **Step 3: Write the implementation**

Create `src/webview/palettes.ts`:

```ts
export type ColorScheme = "default" | "vivid" | "soft" | "contrast";
export type ThemeKind = "light" | "dark";

export interface Palette {
  background: string;
  nodeFill: string;
  nodeBorder: string;
  nodeText: string;
  entryFill: string;
  entryBorder: string;
  methodBorder: string;
  nestedBorder: string;
  edge: string;
  cycle: string;
  nodeBorderWidth: number;
  entryBorderWidth: number;
  edgeWidth: number;
  cycleWidth: number;
}

export const COLOR_SCHEMES: { id: ColorScheme; label: string }[] = [
  { id: "default", label: "Default" },
  { id: "vivid", label: "Vivid" },
  { id: "soft", label: "Soft" },
  { id: "contrast", label: "High contrast" },
];

export function isColorScheme(value: unknown): value is ColorScheme {
  return (
    value === "default" ||
    value === "vivid" ||
    value === "soft" ||
    value === "contrast"
  );
}

type CssVariable = (name: string, fallback: string) => string;
type Colors = Omit<
  Palette,
  "nodeBorderWidth" | "entryBorderWidth" | "edgeWidth" | "cycleWidth"
>;

const WIDTHS = {
  nodeBorderWidth: 1.5,
  entryBorderWidth: 2.5,
  edgeWidth: 1.5,
  cycleWidth: 1.5,
};

const CONTRAST_WIDTHS = {
  nodeBorderWidth: 2,
  entryBorderWidth: 3,
  edgeWidth: 2,
  cycleWidth: 2,
};

const FIXED: Record<Exclude<ColorScheme, "default">, Record<ThemeKind, Colors>> = {
  vivid: {
    light: {
      background: "#ffffff",
      nodeFill: "#f8fafc",
      nodeBorder: "#2563eb",
      nodeText: "#0f172a",
      entryFill: "#dcfce7",
      entryBorder: "#16a34a",
      methodBorder: "#7c3aed",
      nestedBorder: "#ea580c",
      edge: "#334155",
      cycle: "#d97706",
    },
    dark: {
      background: "#1e1e1e",
      nodeFill: "#252526",
      nodeBorder: "#60a5fa",
      nodeText: "#e2e8f0",
      entryFill: "#14351f",
      entryBorder: "#4ade80",
      methodBorder: "#c084fc",
      nestedBorder: "#fb923c",
      edge: "#94a3b8",
      cycle: "#fbbf24",
    },
  },
  soft: {
    light: {
      background: "#fbfbfd",
      nodeFill: "#f4f6f9",
      nodeBorder: "#c3ccd9",
      nodeText: "#3b4252",
      entryFill: "#e6f4ea",
      entryBorder: "#81c995",
      methodBorder: "#b39ddb",
      nestedBorder: "#e8b4a2",
      edge: "#aab4c3",
      cycle: "#e0b27a",
    },
    dark: {
      background: "#1f1f23",
      nodeFill: "#2a2a30",
      nodeBorder: "#4b5563",
      nodeText: "#d7dae0",
      entryFill: "#213a2c",
      entryBorder: "#74c69d",
      methodBorder: "#a78bfa",
      nestedBorder: "#e6a08a",
      edge: "#6b7280",
      cycle: "#d9a441",
    },
  },
  contrast: {
    light: {
      background: "#ffffff",
      nodeFill: "#ffffff",
      nodeBorder: "#000000",
      nodeText: "#000000",
      entryFill: "#ffe066",
      entryBorder: "#000000",
      methodBorder: "#0047ab",
      nestedBorder: "#6a1b9a",
      edge: "#000000",
      cycle: "#b00020",
    },
    dark: {
      background: "#000000",
      nodeFill: "#111111",
      nodeBorder: "#ffffff",
      nodeText: "#ffffff",
      entryFill: "#4a3b00",
      entryBorder: "#ffe066",
      methodBorder: "#6cb6ff",
      nestedBorder: "#ff8ad8",
      edge: "#ffffff",
      cycle: "#ffd43b",
    },
  },
};

export function resolvePalette(
  scheme: ColorScheme,
  theme: ThemeKind,
  cssVar: CssVariable
): Palette {
  if (scheme === "default") {
    return {
      background: cssVar("--vscode-editor-background", "#1e1e1e"),
      nodeFill: cssVar("--vscode-editorWidget-background", "#252526"),
      nodeBorder: cssVar("--vscode-editorWidget-border", "#454545"),
      nodeText: cssVar("--vscode-editor-foreground", "#cccccc"),
      entryFill: cssVar("--vscode-list-activeSelectionBackground", "#094771"),
      entryBorder: cssVar("--vscode-focusBorder", "#007acc"),
      methodBorder: cssVar("--vscode-symbolIcon-methodForeground", "#4ec9b0"),
      nestedBorder: cssVar("--vscode-symbolIcon-functionForeground", "#c586c0"),
      edge: cssVar("--vscode-descriptionForeground", "#8a8a8a"),
      cycle: cssVar("--vscode-editorWarning-foreground", "#d7a15c"),
      ...WIDTHS,
    };
  }
  return {
    ...FIXED[scheme][theme],
    ...(scheme === "contrast" ? CONTRAST_WIDTHS : WIDTHS),
  };
}
```

- [ ] **Step 4: Run the test and typecheck**

```powershell
npx vitest run src/webview/palettes.test.ts
npm run typecheck
```

Expected: all palette tests PASS; typecheck prints nothing and exits 0.

- [ ] **Step 5: Commit**

```powershell
git add src/webview/palettes.ts src/webview/palettes.test.ts
git commit -m "feat: add graph color palette presets"
```

---

### Task 2: Protocol and persistence

**Files:**
- Modify: `src/protocol.ts:55-64`
- Modify: `src/controller.ts:4-21, 33-48, 190-216`

**Interfaces:**
- Consumes: `ColorScheme`, `isColorScheme` from Task 1.
- Produces: `HostToWebview` gets `{ type: "scheme"; scheme: ColorScheme }`;
  `WebviewToHost` gets `{ type: "scheme"; scheme: ColorScheme }`.

- [ ] **Step 1: Extend the protocol**

In `src/protocol.ts`, add the import at the top:

```ts
import type { ColorScheme } from "./webview/palettes";
```

Replace the two message unions with:

```ts
export type HostToWebview =
  | { type: "graph"; payload: AnalyzerResult; showUncalled: boolean; warning?: string }
  | { type: "cursor"; line: number; endLine?: number }
  | { type: "scheme"; scheme: ColorScheme }
  | { type: "state"; state: WebviewState };

export type WebviewToHost =
  | { type: "ready" }
  | { type: "scheme"; scheme: ColorScheme }
  | { type: "jump"; line: number }
  | { type: "refresh" }
  | { type: "openSettings" };
```

- [ ] **Step 2: Add controller state and persistence**

In `src/controller.ts`, add to the imports:

```ts
import { isColorScheme, type ColorScheme } from "./webview/palettes";
```

Add the field above the constructor and replace the constructor:

```ts
private scheme: ColorScheme;

constructor(private readonly context: vscode.ExtensionContext) {
  const stored = context.globalState.get<unknown>("pyCallMap.colorScheme");
  this.scheme = isColorScheme(stored) ? stored : "default";
}
```

In `onMessage`, send the scheme when the webview becomes ready:

```ts
      case "ready":
        this.panelReady = true;
        this.post({ type: "scheme", scheme: this.scheme });
        if (this.currentState) {
          this.post({ type: "state", state: this.currentState });
        } else if (this.lastResult) {
          this.postGraph(this.lastResult);
        }
        break;
```

Add the handler after the `ready` case:

```ts
      case "scheme":
        if (isColorScheme(message.scheme)) {
          this.scheme = message.scheme;
          void this.context.globalState.update(
            "pyCallMap.colorScheme",
            this.scheme
          );
        }
        break;
```

- [ ] **Step 3: Typecheck**

```powershell
npm run typecheck
```

Expected: exits 0 with no output.

- [ ] **Step 4: Commit**

```powershell
git add src/protocol.ts src/controller.ts
git commit -m "feat: persist the selected graph color scheme"
```

---

### Task 3: Webview palette application and dropdown

**Files:**
- Modify: `src/webview/main.ts:1-59, 196-228, 326-342, 380-388`
- Modify: `src/controller.ts:718-725`
- Modify: `src/webview/styles.css:22-67`

**Interfaces:**
- Consumes: `COLOR_SCHEMES`, `isColorScheme`, `resolvePalette`, `Palette`,
  `ColorScheme`, `ThemeKind` from Task 1; the `scheme` messages from Task 2.
- Produces: the `#scheme` element is populated and reacts to changes.

- [ ] **Step 1: Add imports and DOM/state fields**

At the top of `src/webview/main.ts`, add:

```ts
import {
  COLOR_SCHEMES,
  isColorScheme,
  resolvePalette,
  type ColorScheme,
  type Palette,
  type ThemeKind,
} from "./palettes";
```

Add next to the other element lookups:

```ts
const schemeSelect = document.getElementById("scheme") as HTMLSelectElement;
```

Add to `interface State`:

```ts
  scheme: ColorScheme;
```

Add to the `state` initializer:

```ts
  scheme: "default",
```

- [ ] **Step 2: Replace the style function**

Replace the entire existing `graphStyle()` function with:

```ts
function themeKind(): ThemeKind {
  return document.body.classList.contains("vscode-light") ? "light" : "dark";
}

function currentPalette(): Palette {
  return resolvePalette(state.scheme, themeKind(), cssVariable);
}

function applyPalette(): void {
  canvas.style.background = currentPalette().background;
  if (cy) {
    cy.style(graphStyle() as unknown as cytoscape.StylesheetJson);
  }
}

function graphStyle(palette: Palette = currentPalette()): GraphStylesheet[] {
  const fontFamily = cssVariable("--vscode-editor-font-family", "monospace");
  return [
    {
      selector: "node",
      style: {
        shape: "round-rectangle",
        "background-color": palette.nodeFill,
        "border-width": palette.nodeBorderWidth,
        "border-color": palette.nodeBorder,
        label: "data(label)",
        color: palette.nodeText,
        "font-size": 11,
        "font-family": fontFamily,
        width: "label",
        height: "label",
        "min-width": "90px",
        "min-height": "30px",
        padding: "8px",
        "text-valign": "center",
        "text-halign": "center",
      },
    },
    {
      selector: "node[?entry]",
      style: {
        "background-color": palette.entryFill,
        "border-color": palette.entryBorder,
        "border-width": palette.entryBorderWidth,
      },
    },
    {
      selector: 'node[kind = "method"]',
      style: { "border-color": palette.methodBorder },
    },
    {
      selector: 'node[kind = "nested"]',
      style: { "border-color": palette.nestedBorder },
    },
    {
      selector: "node[?unused]",
      style: { "border-style": "dashed", opacity: 0.55 },
    },
    {
      selector: "node.cursor",
      style: { "border-width": 3, "border-color": palette.nodeText },
    },
    {
      selector: "edge",
      style: {
        width: palette.edgeWidth,
        "line-color": palette.edge,
        "target-arrow-color": palette.edge,
        "target-arrow-shape": "triangle",
        "curve-style": "bezier",
        label: "data(label)",
        "font-size": 9,
        color: palette.edge,
      },
    },
    {
      selector: "edge[?cyclic]",
      style: {
        "line-style": "dashed",
        "line-color": palette.cycle,
        "target-arrow-color": palette.cycle,
        width: palette.cycleWidth,
      },
    },
  ];
}
```

This removes the old `cssVariable` calls that lived inside `graphStyle`; keep the `cssVariable` helper itself unchanged above it.

- [ ] **Step 3: Handle the host scheme message**

In the `window.addEventListener("message", ...)` handler, before the `graph` branch, add:

```ts
  if (message.type === "scheme") {
    if (isColorScheme(message.scheme)) {
      state.scheme = message.scheme;
      schemeSelect.value = message.scheme;
      applyPalette();
    }
    return;
  }
```

- [ ] **Step 4: Wire the dropdown and theme observer**

After the existing `toggleButton` listener, add:

```ts
for (const scheme of COLOR_SCHEMES) {
  const option = document.createElement("option");
  option.value = scheme.id;
  option.textContent = scheme.label;
  schemeSelect.append(option);
}
schemeSelect.value = state.scheme;
schemeSelect.addEventListener("change", () => {
  if (!isColorScheme(schemeSelect.value)) {
    return;
  }
  state.scheme = schemeSelect.value;
  applyPalette();
  vscode.postMessage({ type: "scheme", scheme: state.scheme } satisfies WebviewToHost);
});
```

Replace the theme observer callback body with:

```ts
const themeObserver = new MutationObserver(() => {
  applyPalette();
});
```

Immediately before `applyState();` near the bottom, add:

```ts
applyPalette();
```

- [ ] **Step 5: Add the toolbar markup and styles**

In `getHtml()` in `src/controller.ts`, insert this line after
`<span class="spacer"></span>` and before the refresh button:

```html
      <select id="scheme" title="Color scheme" aria-label="Color scheme"></select>
```

Append to `src/webview/styles.css` after the `#toolbar button.active` rule:

```css
#scheme {
  height: 24px;
  padding: 0 4px;
  font-size: 12px;
  color: var(--vscode-dropdown-foreground);
  background: var(--vscode-dropdown-background);
  border: 1px solid var(--vscode-dropdown-border);
  border-radius: 3px;
}
```

- [ ] **Step 6: Typecheck and build**

```powershell
npm run typecheck
npm run build
```

Expected: both exit 0; the build prints the `dist/extension.js` and `media/main.js` sizes.

- [ ] **Step 7: Commit**

```powershell
git add src/webview/main.ts src/controller.ts src/webview/styles.css
git commit -m "feat: apply the selected color scheme in the webview"
```

---

### Task 4: Docs, version, and release

**Files:**
- Modify: `README.md:10-21`
- Modify: `CHANGELOG.md:1-6`
- Modify: `package.json:5`
- Modify: `package-lock.json:3,9`

**Interfaces:**
- Consumes: the working selector from Task 3.
- Produces: a packaged `py-call-map-0.3.0.vsix`.

- [ ] **Step 1: Update docs and version**

Add to the README Features list:

```markdown
- Four graph color schemes from the toolbar: Default, Vivid, Soft, and High contrast
```

Add to the top of `CHANGELOG.md`, after `# Changelog`:

```markdown
## 0.3.0 - 2026-10-18

- Add four selectable graph color schemes (Default, Vivid, Soft, High contrast).
- Remember the chosen scheme across windows.
```

Change `"version"` to `0.3.0` in `package.json` and in both places in
`package-lock.json` (lines 3 and 9).

- [ ] **Step 2: Run the full verification suite**

```powershell
npm run typecheck
npm test
python -m unittest discover -s test/python -p "test_*.py" -v
npm run build
npm run package
```

Expected: typecheck clean; every Vitest test passes (41 existing plus the new
palette tests); 31 Python tests pass; build succeeds; packaging writes
`py-call-map-0.3.0.vsix`.

- [ ] **Step 3: Commit**

```powershell
git add README.md CHANGELOG.md package.json package-lock.json
git commit -m "chore: release 0.3.0"
```

- [ ] **Step 4: Manual smoke test (Extension Development Host)**

Run `F5`, open `examples/demo.py`, and confirm:

1. The toolbar shows the dropdown with four options.
2. Each option recolors the graph immediately.
3. Switching the VS Code theme between light and dark keeps the preset and switches
   its variant.
4. Reload the window; the last selection is still shown.
