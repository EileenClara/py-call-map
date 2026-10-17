import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("pyCallMap.show", () => {
      void vscode.window.showInformationMessage("PyCallMap is ready.");
    })
  );
}

export function deactivate(): void {}
