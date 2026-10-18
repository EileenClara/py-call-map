import cytoscape from "cytoscape";
import dagre from "cytoscape-dagre";
import "./styles.css";
import type { AnalyzerResult, HostToWebview, WebviewToHost } from "../protocol";
import { buildElements, findFunctionAtLine } from "./graph";

cytoscape.use(dagre);

const vscode = acquireVsCodeApi();
const canvas = document.getElementById("canvas") as HTMLDivElement;
const overlay = document.getElementById("overlay") as HTMLDivElement;
const overlayContent = document.getElementById("overlay-content") as HTMLDivElement;
const banner = document.getElementById("banner") as HTMLDivElement;
const tooltip = document.getElementById("tooltip") as HTMLDivElement;
const fileLabel = document.getElementById("file") as HTMLSpanElement;
const refreshButton = document.getElementById("refresh") as HTMLButtonElement;
const fitButton = document.getElementById("fit") as HTMLButtonElement;
const toggleButton = document.getElementById("toggle-uncalled") as HTMLButtonElement;

interface State {
  result?: AnalyzerResult;
  showUncalled: boolean;
  initialized: boolean;
  cursorLine?: number;
  cursorEndLine?: number;
  warning?: string;
  status: "loading" | "graph" | "notPython" | "empty" | "error";
  error?: { title: string; detail: string; canOpenSettings: boolean };
  lastFile?: string;
}

interface GraphStylesheet {
  selector: string;
  style: Record<string, unknown>;
}

const state: State = {
  showUncalled: false,
  initialized: false,
  status: "loading",
};

let cy: cytoscape.Core | undefined;

function cssVariable(name: string, fallback: string): string {
  const value = getComputedStyle(document.body).getPropertyValue(name).trim();
  return value || fallback;
}

function graphStyle(): GraphStylesheet[] {
  const foreground = cssVariable("--vscode-editor-foreground", "#cccccc");
  const nodeBackground = cssVariable("--vscode-editorWidget-background", "#252526");
  const nodeBorder = cssVariable("--vscode-editorWidget-border", "#454545");
  const entryBackground = cssVariable("--vscode-list-activeSelectionBackground", "#094771");
  const entryBorder = cssVariable("--vscode-focusBorder", "#007acc");
  const methodBorder = cssVariable("--vscode-symbolIcon-methodForeground", "#4ec9b0");
  const nestedBorder = cssVariable("--vscode-symbolIcon-functionForeground", "#c586c0");
  const edgeColor = cssVariable("--vscode-descriptionForeground", "#8a8a8a");
  const cyclicColor = cssVariable("--vscode-editorWarning-foreground", "#d7a15c");
  const fontFamily = cssVariable("--vscode-editor-font-family", "monospace");
  return [
    {
      selector: "node",
      style: {
        shape: "round-rectangle",
        "background-color": nodeBackground,
        "border-width": 1,
        "border-color": nodeBorder,
        label: "data(label)",
        color: foreground,
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
        "background-color": entryBackground,
        "border-color": entryBorder,
        "border-width": 2,
      },
    },
    {
      selector: 'node[kind = "method"]',
      style: { "border-color": methodBorder },
    },
    {
      selector: 'node[kind = "nested"]',
      style: { "border-color": nestedBorder },
    },
    {
      selector: "node[?unused]",
      style: { "border-style": "dashed", opacity: 0.55 },
    },
    {
      selector: "node.cursor",
      style: { "border-width": 3, "border-color": foreground },
    },
    {
      selector: "edge",
      style: {
        width: 1.2,
        "line-color": edgeColor,
        "target-arrow-color": edgeColor,
        "target-arrow-shape": "triangle",
        "curve-style": "bezier",
        label: "data(label)",
        "font-size": 9,
        color: edgeColor,
      },
    },
    {
      selector: "edge[?cyclic]",
      style: {
        "line-style": "dashed",
        "line-color": cyclicColor,
        "target-arrow-color": cyclicColor,
      },
    },
  ];
}

function layoutOptions(): cytoscape.LayoutOptions {
  return {
    name: "dagre",
    rankDir: "LR",
    nodeSep: 40,
    rankSep: 80,
    edgeSep: 20,
    animate: false,
    fit: false,
  } as unknown as cytoscape.LayoutOptions;
}

function showTooltip(text: string, position: { x: number; y: number }): void {
  tooltip.textContent = text;
  tooltip.hidden = false;
  tooltip.style.left = `${position.x + 12}px`;
  tooltip.style.top = `${position.y + 12}px`;
}

function hideTooltip(): void {
  tooltip.hidden = true;
}

function installHandlers(): void {
  if (!cy) {
    return;
  }
  cy.on("tap", "node", (event) => {
    const line = event.target.data("line") as number;
    if (typeof line === "number") {
      vscode.postMessage({ type: "jump", line } satisfies WebviewToHost);
    }
  });
  cy.on("tap", "edge", (event) => {
    const lines = event.target.data("lines") as number[] | undefined;
    if (lines && lines.length > 0) {
      vscode.postMessage({ type: "jump", line: lines[0] } satisfies WebviewToHost);
    }
  });
  cy.on("mouseover", "node", (event) => {
    const data = event.target.data();
    const location =
      typeof data.location === "string"
        ? data.location
        : `lines ${data.line}-${data.endLine}`;
    showTooltip(
      `${data.signature}\n${location}\nexternal calls: ${data.externalCalls}`,
      event.renderedPosition
    );
  });
  cy.on("mouseout", "node", () => hideTooltip());
  cy.on("mouseover", "edge", (event) => {
    const data = event.target.data();
    const locations = data.locations as string[] | undefined;
    const where =
      locations && locations.length > 0
        ? locations.join(", ")
        : `lines ${(data.lines as number[]).join(", ")}`;
    showTooltip(
      `${data.source} → ${data.target}\n${where}`,
      event.renderedPosition
    );
  });
  cy.on("mouseout", "edge", () => hideTooltip());
}

function renderGraph(): void {
  if (!state.result) {
    return;
  }
  const elements = buildElements(state.result, state.showUncalled) as unknown as cytoscape.ElementDefinition[];
  const fileChanged = state.lastFile !== state.result.file;
  if (!cy) {
    cy = cytoscape({
      container: canvas,
      elements,
      style: graphStyle() as unknown as cytoscape.StylesheetJson,
      layout: layoutOptions(),
      wheelSensitivity: 0.2,
    });
    installHandlers();
    cy.fit(undefined, 40);
  } else if (fileChanged) {
    cy.elements().remove();
    cy.add(elements);
    cy.layout(layoutOptions()).run();
    cy.fit(undefined, 40);
  } else {
    const zoom = cy.zoom();
    const pan = cy.pan();
    cy.elements().remove();
    cy.add(elements);
    cy.layout(layoutOptions()).run();
    cy.zoom(zoom);
    cy.pan(pan);
  }
  state.lastFile = state.result.file;
  updateCursor();
}

function updateCursor(): void {
  if (!cy || !state.result) {
    return;
  }
  cy.nodes().removeClass("cursor");
  if (state.cursorLine === undefined) {
    return;
  }
  if (state.cursorEndLine === undefined) {
    const target = findFunctionAtLine(state.result.functions, state.cursorLine);
    if (target) {
      cy.getElementById(target.id).addClass("cursor");
    }
    return;
  }
  const start = state.cursorLine;
  const end = state.cursorEndLine;
  const candidates = state.result.functions.filter(
    (fn) => fn.line <= end && start <= fn.endLine
  );
  for (const fn of candidates) {
    const containsNested = candidates.some(
      (other) =>
        other !== fn &&
        fn.line <= other.line &&
        other.endLine <= fn.endLine &&
        other.endLine - other.line < fn.endLine - fn.line
    );
    if (!containsNested) {
      cy.getElementById(fn.id).addClass("cursor");
    }
  }
}

function basename(file: string): string {
  const parts = file.split(/[\\/]/);
  return parts[parts.length - 1] ?? file;
}

function updateChrome(): void {
  fileLabel.textContent = state.result ? basename(state.result.file) : "";
  banner.hidden = !state.warning;
  banner.textContent = state.warning ?? "";
  toggleButton.classList.toggle("active", state.showUncalled);
}

function showOverlay(title: string, detail = "", canOpenSettings = false): void {
  overlay.hidden = false;
  overlayContent.innerHTML = "";
  const heading = document.createElement("h2");
  heading.textContent = title;
  overlayContent.appendChild(heading);
  if (detail) {
    const paragraph = document.createElement("p");
    paragraph.textContent = detail;
    overlayContent.appendChild(paragraph);
  }
  if (canOpenSettings) {
    const button = document.createElement("button");
    button.textContent = "Open Settings";
    button.addEventListener("click", () => {
      vscode.postMessage({ type: "openSettings" } satisfies WebviewToHost);
    });
    overlayContent.appendChild(button);
  }
}

function hideOverlay(): void {
  overlay.hidden = true;
}

function applyState(): void {
  updateChrome();
  switch (state.status) {
    case "loading":
      showOverlay("Analyzing...");
      break;
    case "notPython":
      showOverlay("Current file is not a Python file.");
      break;
    case "empty":
      showOverlay("No function definitions found.");
      break;
    case "error":
      showOverlay(
        state.error?.title ?? "Analysis failed",
        state.error?.detail ?? "",
        state.error?.canOpenSettings ?? false
      );
      break;
    case "graph":
      hideOverlay();
      break;
  }
}

window.addEventListener("message", (event: MessageEvent<HostToWebview>) => {
  const message = event.data;
  if (message.type === "graph") {
    state.result = message.payload;
    state.warning = message.warning;
    state.status = "graph";
    state.error = undefined;
    state.cursorLine = undefined;
    state.cursorEndLine = undefined;
    if (!state.initialized) {
      state.showUncalled = message.showUncalled;
      state.initialized = true;
    }
    applyState();
    renderGraph();
    return;
  }
  if (message.type === "cursor") {
    state.cursorLine = message.line;
    state.cursorEndLine = message.endLine;
    updateCursor();
    return;
  }
  if (message.type === "state") {
    state.status = message.state.kind;
    state.error = message.state.kind === "error" ? message.state : undefined;
    state.warning = undefined;
    if (
      message.state.kind === "error" ||
      message.state.kind === "empty" ||
      message.state.kind === "notPython"
    ) {
      state.result = undefined;
      cy?.destroy();
      cy = undefined;
      state.lastFile = undefined;
      hideTooltip();
    }
    applyState();
  }
});

refreshButton.addEventListener("click", () => {
  vscode.postMessage({ type: "refresh" } satisfies WebviewToHost);
});
fitButton.addEventListener("click", () => {
  cy?.fit(undefined, 40);
});
toggleButton.addEventListener("click", () => {
  state.showUncalled = !state.showUncalled;
  updateChrome();
  renderGraph();
});

const themeObserver = new MutationObserver(() => {
  if (cy) {
    cy.style(graphStyle() as unknown as cytoscape.StylesheetJson);
  }
});
themeObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });

applyState();
vscode.postMessage({ type: "ready" } satisfies WebviewToHost);
