import * as vscode from "vscode";
import { CallGraphController } from "./controller";

export function activate(context: vscode.ExtensionContext): void {
  const controller = new CallGraphController(context);
  context.subscriptions.push(controller);
  context.subscriptions.push(
    vscode.commands.registerCommand("pyCallMap.show", () => controller.show())
  );
}

export function deactivate(): void {}
