import "./styles.css";

const vscode = acquireVsCodeApi();
const overlay = document.getElementById("overlay") as HTMLDivElement;
const overlayContent = document.getElementById("overlay-content") as HTMLDivElement;

interface ShellState {
  kind?: string;
}

function showMessage(title: string, detail = ""): void {
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
}

window.addEventListener("message", (event: MessageEvent<{ type?: string; state?: ShellState }>) => {
  const message = event.data;
  if (message?.type === "state") {
    if (message.state?.kind === "notPython") {
      showMessage("Current file is not a Python file.");
    } else if (message.state?.kind === "empty") {
      showMessage("No function definitions found.");
    } else {
      showMessage("Analyzing...");
    }
  }
});

showMessage("Analyzing...");
vscode.postMessage({ type: "ready" });
