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

const FIXED: Record<
  Exclude<ColorScheme, "default">,
  Record<ThemeKind, Colors>
> = {
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
      entryFill: cssVar("--vscode-editorWidget-background", "#252526"),
      entryBorder: cssVar("--vscode-focusBorder", "#007acc"),
      methodBorder: cssVar("--vscode-symbolIcon-methodForeground", "#4ec9b0"),
      nestedBorder: cssVar(
        "--vscode-symbolIcon-functionForeground",
        "#c586c0"
      ),
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
