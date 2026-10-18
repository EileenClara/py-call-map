# Selectable Graph Color Schemes — Design

**Goal:** Add a toolbar dropdown with four color schemes — Default, Vivid, Soft, High
contrast — each with light and dark variants, and remember the user's choice.

**Scope:** Only the call-graph canvas is recolored. The toolbar, banner, overlay, and
tooltip continue to follow the VS Code theme. No per-color customization and no new
VS Code setting.

## Presets

| Id | Label | Character |
| --- | --- | --- |
| `default` | Default | Resolved from the active VS Code theme variables |
| `vivid` | Vivid | Blue function borders, green entry, purple methods |
| `soft` | Soft | Muted slate borders and pale fills |
| `contrast` | High contrast | Black/white strokes on white/black, yellow entry |

`default` keeps the existing theme-variable strategy and only strengthens strokes:
node border 1.5, entry border 2.5, edge width 1.5, cycle width 1.5. Missing CSS
variables keep their current fallbacks.

The three fixed presets use explicit light/dark values:

### Vivid

| Token | Light | Dark |
| --- | --- | --- |
| canvas background | `#ffffff` | `#1e1e1e` |
| node fill | `#f8fafc` | `#252526` |
| node border | `#2563eb` | `#60a5fa` |
| node text | `#0f172a` | `#e2e8f0` |
| entry fill | `#dcfce7` | `#14351f` |
| entry border | `#16a34a` | `#4ade80` |
| method border | `#7c3aed` | `#c084fc` |
| nested border | `#ea580c` | `#fb923c` |
| edge | `#334155` | `#94a3b8` |
| cycle | `#d97706` | `#fbbf24` |

### Soft

| Token | Light | Dark |
| --- | --- | --- |
| canvas background | `#fbfbfd` | `#1f1f23` |
| node fill | `#f4f6f9` | `#2a2a30` |
| node border | `#c3ccd9` | `#4b5563` |
| node text | `#3b4252` | `#d7dae0` |
| entry fill | `#e6f4ea` | `#213a2c` |
| entry border | `#81c995` | `#74c69d` |
| method border | `#b39ddb` | `#a78bfa` |
| nested border | `#e8b4a2` | `#e6a08a` |
| edge | `#aab4c3` | `#6b7280` |
| cycle | `#e0b27a` | `#d9a441` |

### High contrast

| Token | Light | Dark |
| --- | --- | --- |
| canvas background | `#ffffff` | `#000000` |
| node fill | `#ffffff` | `#111111` |
| node border | `#000000` | `#ffffff` |
| node text | `#000000` | `#ffffff` |
| entry fill | `#ffe066` | `#4a3b00` |
| entry border | `#000000` | `#ffe066` |
| method border | `#0047ab` | `#6cb6ff` |
| nested border | `#6a1b9a` | `#ff8ad8` |
| edge | `#000000` | `#ffffff` |
| cycle | `#b00020` | `#ffd43b` |

Stroke widths: `contrast` uses node 2, entry 3, edge 2, cycle 2. The other presets use
node 1.5, entry 2.5, edge 1.5, cycle 1.5.

## UI

- A native `<select id="scheme">` in the toolbar, left of the refresh button, with
  options `Default`, `Vivid`, `Soft`, `High contrast`.
- Choosing an option applies immediately by re-applying the cytoscape stylesheet; no
  re-analysis and no layout change.
- Styling uses `--vscode-dropdown-background`, `--vscode-dropdown-foreground`, and
  `--vscode-dropdown-border`.
- The graph canvas element's background comes from the palette; the `default` preset
  resolves it from `--vscode-editor-background`, so the panel stays flush with the
  editor.
- Theme detection: `document.body.classList.contains("vscode-light")` selects the light
  variant; anything else uses dark. A `MutationObserver` on the body class list
  re-applies the palette when the VS Code theme changes.

## Architecture

- **`src/webview/palettes.ts`** (new, pure module):
  - `type ColorScheme = "default" | "vivid" | "soft" | "contrast"`
  - `type ThemeKind = "light" | "dark"`
  - `interface Palette` with `background`, `nodeFill`, `nodeBorder`, `nodeText`,
    `entryFill`, `entryBorder`, `methodBorder`, `nestedBorder`, `edge`, `cycle`, and
    stroke widths.
  - `COLOR_SCHEMES: { id: ColorScheme; label: string }[]`
  - `isColorScheme(value: unknown): value is ColorScheme`
  - `resolvePalette(scheme, theme, cssVar: (name: string, fallback: string) => string)`
    — `default` calls `cssVar`; fixed presets return the tables above.
- **`src/webview/main.ts`**: `graphStyle()` takes the resolved palette; adds the
  dropdown listener and theme `MutationObserver`; sets the initial selection from the
  host message.
- **`src/protocol.ts`**:
  - `HostToWebview` adds `{ type: "scheme"; scheme: ColorScheme }`.
  - `WebviewToHost` adds `{ type: "scheme"; scheme: ColorScheme }`.
- **`src/controller.ts`**: reads and validates `globalState` key
  `"pyCallMap.colorScheme"` (fallback `default`); on `ready` posts the current scheme;
  on a `scheme` message validates, stores it with `globalState.update`, and ignores
  unknown values.

## Error handling

- Unknown or missing stored value → `default`.
- A malformed scheme message is ignored.
- A missing CSS variable falls back exactly as today.

## Testing

- New `src/webview/palettes.test.ts`:
  - every fixed scheme × theme returns every palette token non-empty;
  - high-contrast light has `nodeBorder #000000`, dark has `#ffffff` and thicker
    strokes than `vivid`;
  - `default` calls the injected `cssVar` and returns the variable-derived values;
  - `isColorScheme` accepts the four ids and rejects others.
- Existing typecheck, Vitest suite, Python tests, and esbuild build must stay green.
- Manual check: switch all four presets in light and dark, reload the window, and
  confirm the selection persists.

## Release

- Version `0.3.0`.
- README: add a "Color schemes" feature bullet.
- CHANGELOG: add a `0.3.0` entry.
