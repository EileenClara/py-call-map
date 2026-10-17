# PyCallMap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a VSCode extension that renders the function call graph of a single Python file as an interactive left-to-right diagram, with click-to-code navigation and cursor highlighting.

**Architecture:** A TypeScript extension host spawns a standard-library-only Python script that parses the active file with `ast` and emits JSON. The extension renders that JSON in a webview using Cytoscape.js with a dagre left-to-right layout, and bridges clicks and cursor movement back to the editor.

**Tech Stack:** TypeScript, esbuild, Cytoscape.js, cytoscape-dagre, dagre, Vitest, Python standard library (`ast`, `json`, `tokenize`), `unittest`, GitHub Actions, `@vscode/vsce`.

## Global Constraints

- `python/analyze.py` may import only the Python standard library.
- `engines.vscode` is fixed at `^1.85.0`; use Node 20 and npm.
- Extension ID is `py-call-map`; command and configuration namespace is `pyCallMap`.
- The MVP analyzes a single `.py` file and never executes user code.
- Analyzer JSON uses 1-based line numbers; convert to 0-based only in `src/controller.ts`.
- Analyzer subprocess timeout is 5000 ms; stdout limit is 10 MB.
- Graph layout is always dagre with `rankDir: "LR"`.
- UI strings are English; `README.md` is primarily Chinese with an English summary.
- No network requests and no telemetry.
- Every task ends with passing tests and a git commit.

---

## File Structure

- `package.json` — extension manifest, commands, settings, build scripts.
- `tsconfig.json` — TypeScript compiler configuration.
- `esbuild.mjs` — builds the extension host bundle and the webview bundle.
- `vitest.config.ts` — TypeScript unit test configuration.
- `.vscodeignore` — files excluded from the `.vsix`.
- `.vscode/launch.json`, `.vscode/tasks.json` — F5 debugging.
- `python/analyze.py` — static analyzer; single file, standard library only.
- `src/protocol.ts` — shared JSON and message types.
- `src/pythonBridge.ts` — interpreter discovery, subprocess execution, validation.
- `src/lineNumbers.ts` — 1-based/0-based conversion helpers.
- `src/extension.ts` — activation and command registration.
- `src/controller.ts` — panel lifecycle, refresh scheduling, cache, jump, cursor sync.
- `src/webview/graph.ts` — pure graph data helpers (testable in Node).
- `src/webview/main.ts` — Cytoscape rendering and webview interactions.
- `src/webview/globals.d.ts` — `acquireVsCodeApi` declaration.
- `src/webview/cytoscape-dagre.d.ts` — module declaration for the layout plugin.
- `src/webview/styles.css` — webview styling using VSCode theme variables.
- `test/python/test_analyze.py` — analyzer unit tests.
- `test/ts/pythonBridge.test.ts` — bridge unit tests.
- `test/ts/graph.test.ts` — graph helper unit tests.
- `test/ts/lineNumbers.test.ts` — line conversion tests.
- `examples/demo.py` — manual verification fixture.
- `media/` — build output (`main.js`, `main.css`) plus future icon/screenshot assets.
- `README.md`, `CHANGELOG.md`, `LICENSE`, `.github/workflows/ci.yml`.

---

### Task 1: Scaffold the extension and build pipeline

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `esbuild.mjs`
- Create: `vitest.config.ts`
- Create: `.vscodeignore`
- Create: `.vscode/launch.json`
- Create: `.vscode/tasks.json`
- Modify: `.gitignore`
- Create: `src/extension.ts`
- Create: `src/webview/main.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `npm run build` emits `dist/extension.js` and `media/main.js`; `npm run typecheck` exits 0; the `pyCallMap.show` command exists.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "py-call-map",
  "displayName": "PyCallMap",
  "description": "Visualize Python function calls as an interactive left-to-right call graph.",
  "version": "0.1.0",
  "publisher": "local-dev",
  "license": "MIT",
  "engines": { "vscode": "^1.85.0" },
  "categories": ["Visualization", "Programming Languages", "Educational"],
  "keywords": ["python", "call graph", "visualization", "call hierarchy", "education"],
  "activationEvents": ["onCommand:pyCallMap.show"],
  "main": "./dist/extension.js",
  "contributes": {
    "commands": [
      { "command": "pyCallMap.show", "title": "PyCallMap: Show Function Call Graph" }
    ],
    "menus": {
      "editor/title": [
        {
          "command": "pyCallMap.show",
          "when": "editorLangId == python",
          "group": "navigation",
          "icon": "$(graph)"
        }
      ]
    }
  },
  "capabilities": { "untrustedWorkspaces": { "supported": "limited" } },
  "scripts": {
    "build": "node esbuild.mjs",
    "watch": "node esbuild.mjs --watch",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "package": "npm run build && vsce package --no-dependencies"
  },
  "dependencies": {
    "cytoscape": "^3.30.2",
    "cytoscape-dagre": "^2.5.0",
    "dagre": "^0.8.5"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "@types/vscode": "^1.85.0",
    "@vscode/vsce": "^3.0.0",
    "esbuild": "^0.23.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*.ts", "test/ts/**/*.ts", "vitest.config.ts"]
}
```

- [ ] **Step 3: Create `esbuild.mjs`**

```js
import esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const shared = {
  bundle: true,
  sourcemap: true,
  logLevel: "info",
};

const extensionConfig = {
  ...shared,
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  external: ["vscode"],
};

const webviewConfig = {
  ...shared,
  entryPoints: ["src/webview/main.ts"],
  outfile: "media/main.js",
  platform: "browser",
  format: "iife",
};

if (watch) {
  const extensionContext = await esbuild.context(extensionConfig);
  const webviewContext = await esbuild.context(webviewConfig);
  await Promise.all([extensionContext.watch(), webviewContext.watch()]);
} else {
  await Promise.all([esbuild.build(extensionConfig), esbuild.build(webviewConfig)]);
}
```

- [ ] **Step 4: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/ts/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 5: Create `.vscodeignore`**

```
.vscode/**
.github/**
.superpowers/**
src/**
test/**
docs/**
examples/**
node_modules/**
esbuild.mjs
tsconfig.json
vitest.config.ts
**/*.map
```

- [ ] **Step 6: Create `.vscode/launch.json`**

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run Extension",
      "type": "extensionHost",
      "request": "launch",
      "args": ["--extensionDevelopmentPath=${workspaceFolder}"],
      "outFiles": ["${workspaceFolder}/dist/**/*.js"],
      "preLaunchTask": "npm: build"
    }
  ]
}
```

- [ ] **Step 7: Create `.vscode/tasks.json`**

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "type": "npm",
      "script": "build",
      "group": { "kind": "build", "isDefault": true },
      "problemMatcher": []
    }
  ]
}
```

- [ ] **Step 8: Update `.gitignore`**

Replace the file contents with:

```
node_modules/
dist/
*.vsix
.superpowers/
.DS_Store
Thumbs.db
media/main.js
media/main.css
media/main.js.map
media/main.css.map
```

- [ ] **Step 9: Create the minimal extension entry**

`src/extension.ts`:

```ts
import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("pyCallMap.show", () => {
      void vscode.window.showInformationMessage("PyCallMap is ready.");
    })
  );
}

export function deactivate(): void {}
```

- [ ] **Step 10: Create the minimal webview entry**

`src/webview/main.ts`:

```ts
const root = document.getElementById("root");
if (root) {
  root.textContent = "PyCallMap";
}
```

- [ ] **Step 11: Install dependencies and verify the build**

Run:

```bash
npm install
npm run typecheck
npm run build
```

Expected: `npm install` creates `package-lock.json`; `typecheck` exits 0; `build` creates `dist/extension.js` and `media/main.js`.

- [ ] **Step 12: Manual smoke check**

Press F5 (Extension Development Host), open the Command Palette, run `PyCallMap: Show Function Call Graph`. Expected: an information message `PyCallMap is ready.` appears.

- [ ] **Step 13: Commit**

```bash
git add package.json package-lock.json tsconfig.json esbuild.mjs vitest.config.ts .vscodeignore .vscode .gitignore src/extension.ts src/webview/main.ts
git commit -m "chore: scaffold extension build"
```

---

### Task 2: Implement the Python analyzer

**Files:**
- Create: `python/analyze.py`
- Create: `test/python/test_analyze.py`
- Create: `examples/demo.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `analyze.analyze_file(path: str) -> dict`; the CLI `python -I python/analyze.py --file <path>` prints one JSON object matching `AnalyzerResult` from the spec and exits 0.

- [ ] **Step 1: Write the complete failing test file**

`test/python/test_analyze.py`:

```python
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))

import analyze  # noqa: E402


def source(text: str) -> str:
    return textwrap.dedent(text).lstrip("\n")


def run_source(text: str) -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "sample.py"
        path.write_text(source(text), encoding="utf-8")
        return analyze.analyze_file(str(path))


def run_bytes(data: bytes) -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "sample.py"
        path.write_bytes(data)
        return analyze.analyze_file(str(path))


def ids(result: dict) -> set[str]:
    return {item["id"] for item in result["functions"]}


def function(result: dict, function_id: str) -> dict:
    return next(item for item in result["functions"] if item["id"] == function_id)


def edge_map(result: dict) -> dict[tuple[str, str], dict]:
    return {(item["source"], item["target"]): item for item in result["edges"]}


class AnalyzerTests(unittest.TestCase):
    def test_collects_functions_with_signature_and_lines(self):
        result = run_source("""
            def alpha(a, b=2):
                pass

            async def beta():
                pass
        """)
        self.assertEqual(ids(result), {"alpha", "beta"})
        alpha = function(result, "alpha")
        self.assertEqual(alpha["signature"], "alpha(a, b=...)")
        self.assertEqual(alpha["line"], 1)
        self.assertEqual(alpha["endLine"], 2)
        self.assertEqual(alpha["kind"], "function")
        self.assertIsNone(alpha["owner"])
        self.assertIsNone(alpha["parent"])
        self.assertEqual(function(result, "beta")["kind"], "function")

    def test_builds_and_aggregates_call_edges(self):
        result = run_source("""
            def helper():
                pass

            def main():
                helper()
                helper()
        """)
        edges = edge_map(result)
        self.assertEqual(set(edges), {("main", "helper")})
        self.assertEqual(edges[("main", "helper")]["lines"], [5, 6])
        self.assertFalse(edges[("main", "helper")]["cyclic"])

    def test_module_level_call_marks_entry(self):
        result = run_source("""
            def worker():
                pass

            worker()
        """)
        self.assertTrue(function(result, "worker")["entry"])
        self.assertFalse(function(result, "worker")["unused"])

    def test_main_guard_marks_entry(self):
        result = run_source("""
            def main():
                pass

            if __name__ == "__main__":
                main()
        """)
        self.assertTrue(function(result, "main")["entry"])

    def test_falls_back_to_main_when_no_module_calls(self):
        result = run_source("""
            def helper():
                pass

            def main():
                helper()
        """)
        self.assertTrue(function(result, "main")["entry"])
        self.assertFalse(function(result, "helper")["unused"])

    def test_without_entry_nothing_is_unused(self):
        result = run_source("""
            def a():
                b()

            def b():
                pass
        """)
        self.assertFalse(function(result, "a")["entry"])
        self.assertFalse(function(result, "a")["unused"])
        self.assertFalse(function(result, "b")["unused"])

    def test_unreachable_functions_are_marked_unused(self):
        result = run_source("""
            def dead():
                helper()

            def helper():
                pass

            def main():
                pass
        """)
        self.assertTrue(function(result, "dead")["unused"])
        self.assertTrue(function(result, "helper")["unused"])
        self.assertFalse(function(result, "main")["unused"])

    def test_self_and_mutual_recursion_are_cyclic(self):
        result = run_source("""
            def a():
                b()

            def b():
                a()

            def f():
                f()

            def main():
                a()
                f()
        """)
        edges = edge_map(result)
        self.assertTrue(edges[("a", "b")]["cyclic"])
        self.assertTrue(edges[("b", "a")]["cyclic"])
        self.assertTrue(edges[("f", "f")]["cyclic"])
        self.assertFalse(edges[("main", "a")]["cyclic"])

    def test_self_class_and_super_resolution(self):
        result = run_source("""
            class Base:
                def ping(self):
                    pass

            class Child(Base):
                def run(self):
                    self.ping()
                    Child.ping(self)
                    super().ping()

            def main():
                c = Child()
                c.run()
        """)
        edges = edge_map(result)
        self.assertEqual(set(edges), {("Child.run", "Base.ping")})
        self.assertEqual(edges[("Child.run", "Base.ping")]["lines"], [7, 8, 9])
        self.assertEqual(function(result, "main")["externalCalls"], 1)

    def test_class_instantiation_and_init(self):
        result = run_source("""
            class Thing:
                def __init__(self):
                    pass

                def run(self):
                    pass

            def main():
                Thing()
                Thing().run()
        """)
        edges = edge_map(result)
        self.assertIn(("main", "Thing.__init__"), edges)
        self.assertEqual(edges[("main", "Thing.__init__")]["lines"], [9, 10])
        self.assertEqual(function(result, "main")["externalCalls"], 1)

    def test_classmethod_cls_instantiation(self):
        result = run_source("""
            class Thing:
                def __init__(self):
                    pass

                @classmethod
                def create(cls):
                    return cls()

            def main():
                Thing.create()
        """)
        edges = edge_map(result)
        self.assertIn(("Thing.create", "Thing.__init__"), edges)
        self.assertIn(("main", "Thing.create"), edges)

    def test_internal_class_without_init_has_no_edge(self):
        result = run_source("""
            class Empty:
                pass

            def main():
                Empty()
        """)
        self.assertEqual(result["edges"], [])
        self.assertEqual(function(result, "main")["externalCalls"], 0)

    def test_entry_via_class_instantiation(self):
        result = run_source("""
            class Thing:
                def __init__(self):
                    pass

            Thing()
        """)
        self.assertTrue(function(result, "Thing.__init__")["entry"])

    def test_nested_functions_are_scoped(self):
        result = run_source("""
            def outer():
                def helper():
                    pass
                helper()

            def helper():
                pass

            def main():
                outer()
        """)
        self.assertEqual(ids(result), {"outer", "outer.helper", "helper", "main"})
        nested = function(result, "outer.helper")
        self.assertEqual(nested["kind"], "nested")
        self.assertEqual(nested["parent"], "outer")
        edges = edge_map(result)
        self.assertIn(("outer", "outer.helper"), edges)
        self.assertNotIn(("outer", "helper"), edges)
        self.assertIn(("main", "outer"), edges)
        self.assertTrue(function(result, "helper")["unused"])
        self.assertFalse(function(result, "outer.helper")["unused"])

    def test_nested_function_calls_are_attributed_to_nested(self):
        result = run_source("""
            def base():
                pass

            def outer():
                def inner():
                    base()

                inner()

            def main():
                outer()
        """)
        edges = edge_map(result)
        self.assertIn(("outer.inner", "base"), edges)
        self.assertNotIn(("outer", "base"), edges)
        self.assertIn(("outer", "outer.inner"), edges)

    def test_nested_function_uses_enclosing_scope(self):
        result = run_source("""
            def outer():
                def inner():
                    pass
                def middle():
                    inner()
        """)
        edges = edge_map(result)
        self.assertIn(("outer.middle", "outer.inner"), edges)

    def test_nested_function_inside_method(self):
        result = run_source("""
            class A:
                def run(self):
                    def helper():
                        self.ping()
                    helper()

                def ping(self):
                    pass

            def main():
                A.run()
        """)
        edges = edge_map(result)
        self.assertIn(("A.run.helper", "A.ping"), edges)
        self.assertIn(("A.run", "A.run.helper"), edges)
        self.assertIn(("main", "A.run"), edges)

    def test_duplicate_definitions_use_last_and_warn(self):
        result = run_source("""
            def f():
                pass

            def f():
                pass

            def main():
                f()
        """)
        matches = [item for item in result["functions"] if item["id"] == "f"]
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0]["line"], 4)
        self.assertEqual(len(result["diagnostics"]), 1)
        self.assertEqual(result["diagnostics"][0]["severity"], "warning")
        self.assertIn("Duplicate", result["diagnostics"][0]["message"])
        self.assertIn(("main", "f"), edge_map(result))

    def test_duplicate_method_uses_last_and_warns(self):
        result = run_source("""
            class A:
                def run(self):
                    pass
                def run(self):
                    pass

            def main():
                A.run()
        """)
        matches = [item for item in result["functions"] if item["id"] == "A.run"]
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0]["line"], 4)
        self.assertEqual(len(result["diagnostics"]), 1)
        self.assertIn(("main", "A.run"), edge_map(result))

    def test_external_calls_are_counted(self):
        result = run_source("""
            import json

            def main():
                print("x")
                json.dumps({})
                alias()
                getattr(foo, "x")()
        """)
        self.assertEqual(function(result, "main")["externalCalls"], 5)

    def test_decorators_and_defaults_are_skipped(self):
        result = run_source("""
            def make_default():
                pass

            def deco(fn):
                return fn

            @deco
            def main(x=make_default()):
                pass
        """)
        self.assertEqual(result["edges"], [])
        self.assertEqual(function(result, "main")["externalCalls"], 0)

    def test_class_body_calls_are_skipped(self):
        result = run_source("""
            def helper():
                pass

            class A:
                x = helper()

            def main():
                pass
        """)
        self.assertEqual(result["edges"], [])
        self.assertFalse(function(result, "helper")["entry"])

    def test_lambda_calls_belong_to_enclosing_function(self):
        result = run_source("""
            def helper():
                pass

            def main():
                fn = lambda: helper()
        """)
        self.assertIn(("main", "helper"), edge_map(result))

    def test_type_annotations_are_skipped(self):
        result = run_source("""
            def make_type():
                pass

            def main():
                value: make_type() = 1
        """)
        self.assertEqual(result["edges"], [])
        self.assertEqual(function(result, "main")["externalCalls"], 0)

    def test_syntax_error_returns_diagnostic(self):
        result = run_source("""
            def broken(:
                pass
        """)
        self.assertEqual(result["functions"], [])
        self.assertEqual(result["edges"], [])
        self.assertEqual(result["diagnostics"][0]["severity"], "error")
        self.assertEqual(result["diagnostics"][0]["line"], 1)

    def test_encoding_declaration_is_respected(self):
        data = "# -*- coding: latin-1 -*-\ndef main():\n    name = 'caf\xe9'\n".encode("latin-1")
        result = run_bytes(data)
        self.assertEqual(ids(result), {"main"})
        self.assertEqual(result["diagnostics"], [])

    def test_utf8_bom_is_respected(self):
        result = run_bytes(b"\xef\xbb\xbfdef main():\n    pass\n")
        self.assertEqual(ids(result), {"main"})

    def test_empty_and_import_only_files(self):
        self.assertEqual(run_source("")["functions"], [])
        self.assertEqual(run_source("import os\n")["functions"], [])

    def test_signature_with_varargs_and_kwonly(self):
        result = run_source("""
            def f(a, /, b, *args, c=1, **kwargs):
                pass
        """)
        self.assertEqual(function(result, "f")["signature"], "f(a, b, *args, c=..., **kwargs)")

    def test_edge_ids_are_stable(self):
        result = run_source("""
            def a(): b()
            def b(): pass
            def main(): a()
        """)
        self.assertEqual([edge["id"] for edge in result["edges"]], ["e1", "e2"])

    def test_multiline_endline(self):
        result = run_source("""
            def main():
                if True:
                    pass
        """)
        self.assertEqual(function(result, "main")["endLine"], 3)
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
python -m unittest discover -s test/python -p "test_*.py" -v
```

Expected: `ModuleNotFoundError: No module named 'analyze'` (the implementation does not exist yet).

- [ ] **Step 3: Create `python/analyze.py`**

```python
#!/usr/bin/env python3
"""PyCallMap static analyzer. Standard library only."""

from __future__ import annotations

import argparse
import ast
import json
import sys
import time
import tokenize
from dataclasses import dataclass, field
from typing import Any, Optional

if sys.getrecursionlimit() < 5000:
    sys.setrecursionlimit(5000)


@dataclass
class FunctionInfo:
    id: str
    name: str
    kind: str
    owner: Optional[str]
    parent: Optional[str]
    signature: str
    line: int
    end_line: int
    node: ast.AST
    nested: dict[str, str] = field(default_factory=dict)
    scope_chain: list[dict[str, str]] = field(default_factory=list)


@dataclass
class ClassInfo:
    name: str
    methods: dict[str, FunctionInfo] = field(default_factory=dict)
    base_names: list[str] = field(default_factory=list)


@dataclass
class ResolveResult:
    target: Optional[str]
    external: bool


def _base_name(node: ast.expr) -> Optional[str]:
    if isinstance(node, ast.Name):
        return node.id
    return None


def _signature(node: ast.AST) -> str:
    args = node.args
    parts: list[str] = []
    positional = list(getattr(args, "posonlyargs", [])) + list(args.args)
    defaults = list(args.defaults)
    first_default = len(positional) - len(defaults)
    for index, argument in enumerate(positional):
        text = argument.arg
        if index >= first_default:
            text += "=..."
        parts.append(text)
    if args.vararg is not None:
        parts.append("*" + args.vararg.arg)
    elif args.kwonlyargs:
        parts.append("*")
    for index, argument in enumerate(args.kwonlyargs):
        text = argument.arg
        if args.kw_defaults[index] is not None:
            text += "=..."
        parts.append(text)
    if args.kwarg is not None:
        parts.append("**" + args.kwarg.arg)
    return f"{node.name}({', '.join(parts)})"


class Analyzer:
    def __init__(self, file_path: str):
        self.file_path = file_path
        self.functions: dict[str, FunctionInfo] = {}
        self.classes: dict[str, ClassInfo] = {}
        self.call_edges: dict[tuple[str, str], set[int]] = {}
        self.entry_ids: set[str] = set()
        self.external: dict[str, int] = {}
        self.diagnostics: list[dict[str, Any]] = []
        self.scc_id: dict[str, int] = {}
        self.scc_size: dict[int, int] = {}

    def run(self, tree: ast.Module) -> dict[str, Any]:
        self._collect_symbols(tree)
        self._detect_entries(tree)
        for info in list(self.functions.values()):
            self._walk_body(info)
        self._mark_cycles()
        return self._result()

    # ---------- symbol collection ----------

    def _remove_subtree(self, function_id: str) -> None:
        for key in [key for key in self.functions if key == function_id or key.startswith(function_id + ".")]:
            del self.functions[key]

    def _remove_class(self, class_name: str) -> None:
        class_info = self.classes.pop(class_name, None)
        if class_info is None:
            return
        for method in class_info.methods.values():
            self._remove_subtree(method.id)

    def _warn_duplicate(self, message: str, node: ast.AST) -> None:
        self.diagnostics.append({
            "severity": "warning",
            "message": message,
            "line": getattr(node, "lineno", 0),
            "column": getattr(node, "col_offset", 0),
        })

    def _collect_symbols(self, tree: ast.Module) -> None:
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self._add_function(
                    node,
                    kind="function",
                    owner=None,
                    parent=None,
                    scope_path=node.name,
                    enclosing_scopes=[],
                )
            elif isinstance(node, ast.ClassDef):
                self._add_class(node)

    def _add_function(self, node, *, kind, owner, parent, scope_path, enclosing_scopes) -> FunctionInfo:
        if scope_path in self.functions:
            self._remove_subtree(scope_path)
            self._warn_duplicate(
                f"Duplicate definition of {scope_path}; using line {node.lineno}", node
            )
        info = FunctionInfo(
            id=scope_path,
            name=node.name,
            kind=kind,
            owner=owner,
            parent=parent,
            signature=_signature(node),
            line=node.lineno,
            end_line=getattr(node, "end_lineno", None) or node.lineno,
            node=node,
        )
        self.functions[scope_path] = info
        info.scope_chain = [info.nested] + enclosing_scopes
        for child in node.body:
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                child_id = f"{scope_path}.{child.name}"
                info.nested[child.name] = child_id
                self._add_function(
                    child,
                    kind="nested",
                    owner=owner,
                    parent=scope_path,
                    scope_path=child_id,
                    enclosing_scopes=[info.nested] + enclosing_scopes,
                )
        return info

    def _add_class(self, node: ast.ClassDef) -> None:
        if node.name in self.classes:
            self._remove_class(node.name)
            self._warn_duplicate(
                f"Duplicate definition of class {node.name}; using line {node.lineno}", node
            )
        base_names = []
        for base in node.bases:
            name = _base_name(base)
            if name is not None:
                base_names.append(name)
        class_info = ClassInfo(name=node.name, base_names=base_names)
        self.classes[node.name] = class_info
        for child in node.body:
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                method_id = f"{node.name}.{child.name}"
                method = self._add_function(
                    child,
                    kind="method",
                    owner=node.name,
                    parent=None,
                    scope_path=method_id,
                    enclosing_scopes=[],
                )
                class_info.methods[child.name] = method

    # ---------- resolution ----------

    def _resolve_call(self, call: ast.Call, info: Optional[FunctionInfo]) -> ResolveResult:
        if isinstance(call.func, ast.Name):
            return self._resolve_name(call.func.id, info)
        if isinstance(call.func, ast.Attribute):
            return self._resolve_attribute(call.func, info)
        return ResolveResult(None, True)

    def _resolve_name(self, name: str, info: Optional[FunctionInfo]) -> ResolveResult:
        if info is not None:
            for scope in info.scope_chain:
                if name in scope:
                    return ResolveResult(scope[name], False)
        top_level = self.functions.get(name)
        if top_level is not None and top_level.kind == "function":
            return ResolveResult(top_level.id, False)
        if name == "cls" and info is not None and info.owner is not None:
            return self._instantiate(info.owner)
        if name in self.classes:
            return self._instantiate(name)
        return ResolveResult(None, True)

    def _resolve_attribute(
        self, func: ast.Attribute, info: Optional[FunctionInfo]
    ) -> ResolveResult:
        if info is None or info.owner is None:
            if isinstance(func.value, ast.Name) and func.value.id in self.classes:
                target = self._resolve_method(func.value.id, func.attr)
                return ResolveResult(target, target is None)
            return ResolveResult(None, True)
        value = func.value
        if isinstance(value, ast.Name) and value.id in {"self", "cls"}:
            target = self._resolve_method(info.owner, func.attr)
            return ResolveResult(target, target is None)
        if (
            isinstance(value, ast.Call)
            and isinstance(value.func, ast.Name)
            and value.func.id == "super"
            and not value.args
            and not value.keywords
        ):
            target = self._resolve_in_bases(info.owner, func.attr)
            return ResolveResult(target, target is None)
        if isinstance(value, ast.Name) and value.id in self.classes:
            target = self._resolve_method(value.id, func.attr)
            return ResolveResult(target, target is None)
        return ResolveResult(None, True)

    def _instantiate(self, class_name: str) -> ResolveResult:
        target = self._resolve_method(class_name, "__init__")
        if target is not None:
            return ResolveResult(target, False)
        if class_name in self.classes:
            return ResolveResult(None, False)
        return ResolveResult(None, True)

    def _resolve_method(
        self, class_name: str, method_name: str, seen: Optional[set[str]] = None
    ) -> Optional[str]:
        if seen is None:
            seen = set()
        if class_name in seen:
            return None
        seen.add(class_name)
        class_info = self.classes.get(class_name)
        if class_info is None:
            return None
        method = class_info.methods.get(method_name)
        if method is not None:
            return method.id
        for base in class_info.base_names:
            found = self._resolve_method(base, method_name, seen)
            if found is not None:
                return found
        return None

    def _resolve_in_bases(self, class_name: str, method_name: str) -> Optional[str]:
        class_info = self.classes.get(class_name)
        if class_info is None:
            return None
        seen = {class_name}
        for base in class_info.base_names:
            found = self._resolve_method(base, method_name, seen)
            if found is not None:
                return found
        return None

    # ---------- walking ----------

    def _record_call(self, call: ast.Call, info: FunctionInfo) -> None:
        result = self._resolve_call(call, info)
        if result.target is not None:
            self.call_edges.setdefault((info.id, result.target), set()).add(call.lineno)
        elif result.external:
            self.external[info.id] = self.external.get(info.id, 0) + 1

    def _walk_body(self, info: FunctionInfo) -> None:
        visitor = _BodyCallVisitor(self, info)
        for statement in info.node.body:
            visitor.visit(statement)

    def _detect_entries(self, tree: ast.Module) -> None:
        _ModuleCallVisitor(self).visit(tree)
        if not self.entry_ids:
            main = self.functions.get("main")
            if main is not None and main.kind == "function":
                self.entry_ids.add(main.id)

    # ---------- graph ----------

    def _reachable(self) -> set[str]:
        adjacency: dict[str, set[str]] = {}
        for source, target in self.call_edges:
            adjacency.setdefault(source, set()).add(target)
        seen: set[str] = set()
        stack = list(self.entry_ids)
        while stack:
            current = stack.pop()
            if current in seen:
                continue
            seen.add(current)
            stack.extend(adjacency.get(current, ()))
        return seen

    def _mark_cycles(self) -> None:
        adjacency: dict[str, list[str]] = {}
        for source, target in self.call_edges:
            adjacency.setdefault(source, []).append(target)
        index = [0]
        indices: dict[str, int] = {}
        low: dict[str, int] = {}
        stack: list[str] = []
        on_stack: set[str] = set()

        def strongconnect(node: str) -> None:
            indices[node] = index[0]
            low[node] = index[0]
            index[0] += 1
            stack.append(node)
            on_stack.add(node)
            for next_node in adjacency.get(node, ()):
                if next_node not in indices:
                    strongconnect(next_node)
                    low[node] = min(low[node], low[next_node])
                elif next_node in on_stack:
                    low[node] = min(low[node], indices[next_node])
            if low[node] == indices[node]:
                component: list[str] = []
                while True:
                    member = stack.pop()
                    on_stack.remove(member)
                    component.append(member)
                    if member == node:
                        break
                component_id = len(self.scc_size)
                for member in component:
                    self.scc_id[member] = component_id
                self.scc_size[component_id] = len(component)

        for node in self.functions:
            if node not in indices:
                strongconnect(node)

    def _edge_is_cyclic(self, source: str, target: str) -> bool:
        if source == target:
            return True
        source_component = self.scc_id.get(source)
        target_component = self.scc_id.get(target)
        if source_component is None or source_component != target_component:
            return False
        return self.scc_size.get(source_component, 0) > 1

    # ---------- output ----------

    def _result(self) -> dict[str, Any]:
        reachable = self._reachable()
        has_entries = bool(self.entry_ids)
        functions = []
        for info in sorted(self.functions.values(), key=lambda item: (item.line, item.id)):
            functions.append({
                "id": info.id,
                "name": info.name,
                "signature": info.signature,
                "kind": info.kind,
                "owner": info.owner,
                "parent": info.parent,
                "line": info.line,
                "endLine": info.end_line,
                "entry": info.id in self.entry_ids,
                "unused": has_entries and info.id not in reachable,
                "externalCalls": self.external.get(info.id, 0),
            })
        edge_items = []
        for position, ((source, target), lines) in enumerate(
            sorted(self.call_edges.items()), start=1
        ):
            edge_items.append({
                "id": f"e{position}",
                "source": source,
                "target": target,
                "lines": sorted(lines),
                "cyclic": self._edge_is_cyclic(source, target),
            })
        return {
            "version": 1,
            "file": self.file_path,
            "functions": functions,
            "edges": edge_items,
            "diagnostics": sorted(
                self.diagnostics, key=lambda item: (item["line"], item["column"])
            ),
            "stats": {
                "functionCount": len(functions),
                "edgeCount": len(edge_items),
                "parsedInMs": 0,
            },
        }


class _BodyCallVisitor(ast.NodeVisitor):
    def __init__(self, analyzer: Analyzer, info: FunctionInfo):
        self.analyzer = analyzer
        self.info = info

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        return

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        return

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        return

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        # Type annotations are not part of the runtime call graph.
        if node.value is not None:
            self.visit(node.value)

    def visit_Call(self, node: ast.Call) -> None:
        self.analyzer._record_call(node, self.info)
        self.generic_visit(node)


class _ModuleCallVisitor(ast.NodeVisitor):
    def __init__(self, analyzer: Analyzer):
        self.analyzer = analyzer

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        return

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        return

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        return

    def visit_Lambda(self, node: ast.Lambda) -> None:
        return

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        # Type annotations are not part of the runtime call graph.
        if node.value is not None:
            self.visit(node.value)

    def visit_Call(self, node: ast.Call) -> None:
        result = self.analyzer._resolve_call(node, None)
        if result.target is not None:
            self.analyzer.entry_ids.add(result.target)
        self.generic_visit(node)


def analyze_file(path: str) -> dict[str, Any]:
    started = time.perf_counter()
    try:
        with tokenize.open(path) as handle:
            source = handle.read()
    except (OSError, SyntaxError, UnicodeDecodeError) as exc:
        return _error_result(path, str(exc), 0, 0)
    try:
        tree = ast.parse(source, filename=path)
    except SyntaxError as exc:
        # ast offsets are 0-based; SyntaxError.offset is 1-based.
        return _error_result(path, exc.msg, exc.lineno or 0, max((exc.offset or 1) - 1, 0))
    analyzer = Analyzer(path)
    result = analyzer.run(tree)
    result["stats"]["parsedInMs"] = int((time.perf_counter() - started) * 1000)
    return result


def _error_result(path: str, message: str, line: int, column: int) -> dict[str, Any]:
    return {
        "version": 1,
        "file": path,
        "functions": [],
        "edges": [],
        "diagnostics": [
            {
                "severity": "error",
                "message": message,
                "line": line,
                "column": column,
            }
        ],
        "stats": {"functionCount": 0, "edgeCount": 0, "parsedInMs": 0},
    }


def main(argv: Optional[list[str]] = None) -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(prog="analyze.py")
    parser.add_argument("--file", required=True)
    args = parser.parse_args(argv)
    try:
        result = analyze_file(args.file)
    except Exception as exc:  # last-resort guard: still return valid JSON
        import traceback

        traceback.print_exc(file=sys.stderr)
        result = _error_result(args.file, f"Analyzer crashed: {exc}", 0, 0)
    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: Run the tests and verify they pass**

Run:

```bash
python -m unittest discover -s test/python -p "test_*.py" -v
```

Expected: all tests pass, with `OK` in the final line.

- [ ] **Step 5: Create `examples/demo.py`**

```python
"""Demo file for manual verification of PyCallMap."""

def factorial(n):
    if n <= 1:
        return 1
    return n * factorial(n - 1)


def load_data(path):
    return open(path, encoding="utf-8").read()


def clean(text):
    return text.strip()


def compute(text):
    return len(clean(text))


def process(path):
    text = load_data(path)
    return compute(text)


class Reporter:
    def __init__(self, name):
        self.name = name

    def report(self, value):
        print(f"{self.name}: {value}")


def unused_helper():
    return 42


def main():
    value = factorial(5)
    process("data.txt")
    Reporter("demo").report(value)


if __name__ == "__main__":
    main()
```

- [ ] **Step 6: Verify the CLI output**

Run:

```bash
python -I python/analyze.py --file examples/demo.py
```

Expected: a single JSON line containing `"version": 1`, `"main"`, `"factorial"`, `"Reporter.__init__"`, and an edge with `"cyclic": true` for `factorial -> factorial`.

- [ ] **Step 7: Commit**

```bash
git add python/analyze.py test/python/test_analyze.py examples/demo.py
git commit -m "feat(analyzer): parse Python call graph"
```

---

### Task 3: Add the shared protocol and Python bridge

**Files:**
- Create: `src/protocol.ts`
- Create: `src/pythonBridge.ts`
- Create: `test/ts/pythonBridge.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `AnalyzerResult`, `FunctionNode`, `CallEdge`, `Diagnostic`, `AnalyzerStats`, `HostToWebview`, `WebviewToHost`, `WebviewState`; `analyzeFile(filePath, env, scriptPath, deps)`, `runAnalyzer(python, scriptPath, filePath, deps)`, `parseAnalyzerOutput(raw)`, `pythonCandidates(env)`, `usableCandidates(env)`, `PythonNotFoundError`, `AnalyzerError`, `BridgeEnvironment`, `RunDeps`.

- [ ] **Step 1: Create `src/protocol.ts`**

```ts
export type FunctionKind = "function" | "method" | "nested";

export interface FunctionNode {
  id: string;
  name: string;
  signature: string;
  kind: FunctionKind;
  owner: string | null;
  parent: string | null;
  line: number;
  endLine: number;
  entry: boolean;
  unused: boolean;
  externalCalls: number;
}

export interface CallEdge {
  id: string;
  source: string;
  target: string;
  lines: number[];
  cyclic: boolean;
}

export interface Diagnostic {
  severity: "error" | "warning";
  message: string;
  line: number;
  column: number;
}

export interface AnalyzerStats {
  functionCount: number;
  edgeCount: number;
  parsedInMs: number;
}

export interface AnalyzerResult {
  version: 1;
  file: string;
  functions: FunctionNode[];
  edges: CallEdge[];
  diagnostics: Diagnostic[];
  stats: AnalyzerStats;
}

export type WebviewState =
  | { kind: "loading" }
  | { kind: "notPython" }
  | { kind: "empty" }
  | { kind: "error"; title: string; detail: string; canOpenSettings: boolean };

export type HostToWebview =
  | { type: "graph"; payload: AnalyzerResult; showUncalled: boolean; warning?: string }
  | { type: "cursor"; line: number }
  | { type: "state"; state: WebviewState };

export type WebviewToHost =
  | { type: "ready" }
  | { type: "jump"; line: number }
  | { type: "refresh" }
  | { type: "openSettings" };
```

- [ ] **Step 2: Create the failing bridge tests**

`test/ts/pythonBridge.test.ts`:

```ts
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers";
import type { ChildProcess } from "node:child_process";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { AnalyzerResult } from "../../src/protocol";
import {
  AnalyzerError,
  PythonNotFoundError,
  analyzeFile,
  parseAnalyzerOutput,
  pythonCandidates,
  runAnalyzer,
  usableCandidates,
  type BridgeEnvironment,
} from "../../src/pythonBridge";

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

function asSpawn(child: FakeChild): typeof import("node:child_process").spawn {
  return (() => child as unknown as ChildProcess) as unknown as typeof import("node:child_process").spawn;
}

function sampleResult(): AnalyzerResult {
  return {
    version: 1,
    file: "C:/project/app.py",
    functions: [
      {
        id: "main",
        name: "main",
        signature: "main()",
        kind: "function",
        owner: null,
        parent: null,
        line: 1,
        endLine: 1,
        entry: true,
        unused: false,
        externalCalls: 0,
      },
    ],
    edges: [],
    diagnostics: [],
    stats: { functionCount: 1, edgeCount: 0, parsedInMs: 1 },
  };
}

function env(overrides: Partial<BridgeEnvironment> = {}): BridgeEnvironment {
  return {
    platform: "linux",
    pathExists: () => true,
    workspaceFolder: "/work",
    pythonPathSetting: "",
    ...overrides,
  };
}

describe("pythonCandidates", () => {
  it("orders configured path, venv, then PATH candidates", () => {
    expect(pythonCandidates(env({ pythonPathSetting: "/custom/python" }))).toEqual([
      "/custom/python",
      path.join("/work", ".venv", "bin", "python"),
      "python3",
      "python",
    ]);
  });

  it("uses Scripts/python.exe on Windows", () => {
    expect(
      pythonCandidates(env({ platform: "win32", workspaceFolder: "C:/work" }))
    ).toEqual([
      path.join("C:/work", ".venv", "Scripts", "python.exe"),
      "python",
      "python3",
    ]);
  });
});

describe("usableCandidates", () => {
  it("drops missing absolute paths but keeps PATH names", () => {
    const result = usableCandidates(
      env({ pathExists: (candidate) => candidate === path.join("/work", ".venv", "bin", "python") })
    );
    expect(result).toEqual([
      path.join("/work", ".venv", "bin", "python"),
      "python3",
      "python",
    ]);
  });
});

describe("parseAnalyzerOutput", () => {
  it("parses a valid result", () => {
    expect(parseAnalyzerOutput(JSON.stringify(sampleResult()))).toEqual(sampleResult());
  });

  it("rejects invalid JSON", () => {
    expect(() => parseAnalyzerOutput("not json")).toThrow(AnalyzerError);
  });

  it("rejects an unsupported version", () => {
    expect(() => parseAnalyzerOutput(JSON.stringify({ ...sampleResult(), version: 2 }))).toThrow(
      AnalyzerError
    );
  });

  it("rejects a missing signature field", () => {
    const data = sampleResult();
    delete (data.functions[0] as Partial<AnalyzerResult["functions"][number]>).signature;
    expect(() => parseAnalyzerOutput(JSON.stringify(data))).toThrow(AnalyzerError);
  });
});

describe("runAnalyzer", () => {
  it("resolves when the process exits successfully", async () => {
    const child = new FakeChild();
    const promise = runAnalyzer("python", "analyze.py", "app.py", {
      spawn: asSpawn(child),
    });
    child.stdout.emit("data", Buffer.from(JSON.stringify(sampleResult())));
    child.emit("close", 0);
    await expect(promise).resolves.toEqual(sampleResult());
  });

  it("rejects on a non-zero exit code", async () => {
    const child = new FakeChild();
    const promise = runAnalyzer("python", "analyze.py", "app.py", {
      spawn: asSpawn(child),
    });
    child.stderr.emit("data", Buffer.from("boom"));
    child.emit("close", 1);
    await expect(promise).rejects.toThrow("exited with code 1");
  });

  it("rejects when the interpreter is missing", async () => {
    const child = new FakeChild();
    const promise = runAnalyzer("missing-python", "analyze.py", "app.py", {
      spawn: asSpawn(child),
    });
    child.emit("error", Object.assign(new Error("not found"), { code: "ENOENT" }));
    await expect(promise).rejects.toBeInstanceOf(PythonNotFoundError);
  });

  it("kills the process on timeout", async () => {
    const child = new FakeChild();
    const promise = runAnalyzer("python", "analyze.py", "app.py", {
      spawn: asSpawn(child),
      timeoutMs: 20,
    });
    await expect(promise).rejects.toThrow("timed out");
    expect(child.killed).toBe(true);
  });

  it("rejects when output exceeds the limit", async () => {
    const child = new FakeChild();
    const promise = runAnalyzer("python", "analyze.py", "app.py", {
      spawn: asSpawn(child),
      maxOutputBytes: 8,
    });
    child.stdout.emit("data", Buffer.from("0123456789"));
    await expect(promise).rejects.toThrow("exceeded");
    expect(child.killed).toBe(true);
  });

  it("kills the process when aborted", async () => {
    const child = new FakeChild();
    const controller = new AbortController();
    const promise = runAnalyzer("python", "analyze.py", "app.py", {
      spawn: asSpawn(child),
      signal: controller.signal,
    });
    controller.abort();
    await expect(promise).rejects.toThrow("aborted");
    expect(child.killed).toBe(true);
  });
});

describe("analyzeFile", () => {
  it("falls through to the next candidate on ENOENT", async () => {
    const first = new FakeChild();
    const second = new FakeChild();
    const children = [first, second];
    let index = 0;
    const spawn = (() => children[index++] as unknown as ChildProcess) as unknown as typeof import("node:child_process").spawn;
    const promise = analyzeFile("app.py", env({ workspaceFolder: undefined }), "analyze.py", {
      spawn,
    });
    first.emit("error", Object.assign(new Error("not found"), { code: "ENOENT" }));
    await new Promise((resolve) => setImmediate(resolve));
    second.stdout.emit("data", Buffer.from(JSON.stringify(sampleResult())));
    second.emit("close", 0);
    await expect(promise).resolves.toEqual(sampleResult());
    expect(index).toBe(2);
  });

  it("throws PythonNotFoundError when every candidate fails with ENOENT", async () => {
    const first = new FakeChild();
    const second = new FakeChild();
    const children = [first, second];
    let index = 0;
    const spawn = (() => children[index++] as unknown as ChildProcess) as unknown as typeof import("node:child_process").spawn;
    const promise = analyzeFile("app.py", env({ workspaceFolder: undefined }), "analyze.py", {
      spawn,
    });
    first.emit("error", Object.assign(new Error("not found"), { code: "ENOENT" }));
    await new Promise((resolve) => setImmediate(resolve));
    second.emit("error", Object.assign(new Error("not found"), { code: "ENOENT" }));
    await expect(promise).rejects.toBeInstanceOf(PythonNotFoundError);
  });
});
```

- [ ] **Step 3: Run the bridge tests and verify they fail**

Run:

```bash
npm test
```

Expected: failure because `src/pythonBridge.ts` does not exist.

- [ ] **Step 4: Create `src/pythonBridge.ts`**

```ts
import { spawn as nodeSpawn } from "node:child_process";
import * as path from "node:path";
import type { AnalyzerResult } from "./protocol";

export class AnalyzerError extends Error {
  constructor(message: string, readonly detail = "") {
    super(message);
    this.name = "AnalyzerError";
  }
}

export class PythonNotFoundError extends AnalyzerError {
  constructor() {
    super("Python interpreter not found");
    this.name = "PythonNotFoundError";
  }
}

export interface BridgeEnvironment {
  platform: NodeJS.Platform;
  pathExists: (candidate: string) => boolean;
  workspaceFolder: string | undefined;
  pythonPathSetting: string;
}

export interface RunDeps {
  spawn: typeof nodeSpawn;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export function pythonCandidates(env: BridgeEnvironment): string[] {
  const candidates: string[] = [];
  const configured = env.pythonPathSetting.trim();
  if (configured) {
    candidates.push(configured);
  }
  if (env.workspaceFolder) {
    candidates.push(
      env.platform === "win32"
        ? path.join(env.workspaceFolder, ".venv", "Scripts", "python.exe")
        : path.join(env.workspaceFolder, ".venv", "bin", "python")
    );
  }
  if (env.platform === "win32") {
    candidates.push("python", "python3");
  } else {
    candidates.push("python3", "python");
  }
  return candidates;
}

export function usableCandidates(env: BridgeEnvironment): string[] {
  return pythonCandidates(env).filter((candidate) => {
    if (candidate.includes("/") || candidate.includes("\\")) {
      return env.pathExists(candidate);
    }
    return true;
  });
}

export function runAnalyzer(
  python: string,
  scriptPath: string,
  filePath: string,
  deps: RunDeps
): Promise<AnalyzerResult> {
  return new Promise((resolve, reject) => {
    if (deps.signal?.aborted) {
      reject(new AnalyzerError("Analysis aborted"));
      return;
    }
    const child = deps.spawn(python, ["-I", scriptPath, "--file", filePath], {
      cwd: path.dirname(filePath),
      windowsHide: true,
    });
    const timeoutMs = deps.timeoutMs ?? 5000;
    const maxOutputBytes = deps.maxOutputBytes ?? 10 * 1024 * 1024;
    let stdout = "";
    let stdoutBytes = 0;
    let stderr = "";
    let settled = false;

    const onAbort = (): void => {
      child.kill();
      finish(new AnalyzerError("Analysis aborted"));
    };

    const finish = (error?: Error, result?: AnalyzerResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      deps.signal?.removeEventListener("abort", onAbort);
      if (error) {
        reject(error);
      } else {
        resolve(result as AnalyzerResult);
      }
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(new AnalyzerError(`Analysis timed out after ${timeoutMs} ms`, stderr));
    }, timeoutMs);

    deps.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      stdout += chunk.toString("utf8");
      if (stdoutBytes > maxOutputBytes) {
        child.kill();
        finish(new AnalyzerError(`Analyzer output exceeded ${maxOutputBytes} bytes`, stderr));
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (isEnoent(error)) {
        finish(new PythonNotFoundError());
      } else {
        finish(new AnalyzerError(`Failed to start Python: ${String(error)}`, stderr));
      }
    });
    child.on("close", (code) => {
      if (code !== 0) {
        finish(new AnalyzerError(`Analyzer exited with code ${code}`, stderr));
        return;
      }
      try {
        finish(undefined, parseAnalyzerOutput(stdout));
      } catch (error) {
        finish(error as Error);
      }
    });
  });
}

export async function analyzeFile(
  filePath: string,
  env: BridgeEnvironment,
  scriptPath: string,
  deps: RunDeps
): Promise<AnalyzerResult> {
  for (const candidate of usableCandidates(env)) {
    if (deps.signal?.aborted) {
      throw new AnalyzerError("Analysis aborted");
    }
    try {
      return await runAnalyzer(candidate, scriptPath, filePath, deps);
    } catch (error) {
      if (error instanceof PythonNotFoundError) {
        continue;
      }
      throw error;
    }
  }
  throw new PythonNotFoundError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseAnalyzerOutput(raw: string): AnalyzerResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new AnalyzerError("Analyzer returned invalid JSON", raw.slice(-2000));
  }
  if (
    !isRecord(data) ||
    data.version !== 1 ||
    typeof data.file !== "string" ||
    !Array.isArray(data.functions) ||
    !Array.isArray(data.edges) ||
    !Array.isArray(data.diagnostics) ||
    !isRecord(data.stats)
  ) {
    throw new AnalyzerError("Analyzer returned an invalid result", raw.slice(-2000));
  }
  for (const item of data.functions) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.name !== "string" ||
      typeof item.signature !== "string" ||
      !["function", "method", "nested"].includes(item.kind as string) ||
      (item.owner !== null && typeof item.owner !== "string") ||
      (item.parent !== null && typeof item.parent !== "string") ||
      typeof item.line !== "number" ||
      typeof item.endLine !== "number" ||
      typeof item.entry !== "boolean" ||
      typeof item.unused !== "boolean" ||
      typeof item.externalCalls !== "number"
    ) {
      throw new AnalyzerError("Analyzer returned an invalid function node", raw.slice(-2000));
    }
  }
  for (const item of data.edges) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.source !== "string" ||
      typeof item.target !== "string" ||
      !Array.isArray(item.lines) ||
      item.lines.some((line) => typeof line !== "number") ||
      typeof item.cyclic !== "boolean"
    ) {
      throw new AnalyzerError("Analyzer returned an invalid edge", raw.slice(-2000));
    }
  }
  for (const item of data.diagnostics) {
    if (
      !isRecord(item) ||
      (item.severity !== "error" && item.severity !== "warning") ||
      typeof item.message !== "string" ||
      typeof item.line !== "number" ||
      typeof item.column !== "number"
    ) {
      throw new AnalyzerError("Analyzer returned an invalid diagnostic", raw.slice(-2000));
    }
  }
  const stats = data.stats;
  if (
    typeof stats.functionCount !== "number" ||
    typeof stats.edgeCount !== "number" ||
    typeof stats.parsedInMs !== "number"
  ) {
    throw new AnalyzerError("Analyzer returned invalid stats", raw.slice(-2000));
  }
  return data as unknown as AnalyzerResult;
}
```

- [ ] **Step 5: Run the tests and typecheck**

Run:

```bash
npm test
npm run typecheck
```

Expected: all Vitest tests pass; `tsc --noEmit` exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/protocol.ts src/pythonBridge.ts test/ts/pythonBridge.test.ts
git commit -m "feat(bridge): run the Python analyzer safely"
```

---

### Task 4: Add the webview panel shell

**Files:**
- Create: `src/controller.ts`
- Create: `src/webview/globals.d.ts`
- Create: `src/webview/styles.css`
- Modify: `src/extension.ts`
- Replace: `src/webview/main.ts`

**Interfaces:**
- Consumes: `WebviewState`, `WebviewToHost`, `HostToWebview` from `src/protocol.ts`.
- Produces: `CallGraphController` with `show()` and `dispose()`; the panel HTML element IDs `toolbar`, `title`, `file`, `refresh`, `fit`, `toggle-uncalled`, `banner`, `canvas-wrap`, `canvas`, `tooltip`, `overlay`, `overlay-content`.

- [ ] **Step 1: Create `src/webview/globals.d.ts`**

```ts
interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

declare module "*.css";
```

- [ ] **Step 2: Create `src/webview/styles.css`**

```css
html,
body {
  height: 100%;
}

body {
  margin: 0;
  padding: 0;
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  font-family: var(--vscode-font-family);
  font-size: 13px;
  overflow: hidden;
}

#app {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

#toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border-bottom: 1px solid var(--vscode-editorWidget-border);
  background: var(--vscode-editorWidget-background);
  flex: 0 0 auto;
}

#title {
  font-weight: 600;
}

#file {
  color: var(--vscode-descriptionForeground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 40%;
}

.spacer {
  flex: 1;
}

#toolbar button {
  background: transparent;
  border: 1px solid transparent;
  color: var(--vscode-foreground);
  border-radius: 4px;
  width: 26px;
  height: 24px;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
}

#toolbar button:hover {
  background: var(--vscode-toolbar-hoverBackground);
}

#toolbar button.active {
  background: var(--vscode-inputOption-activeBackground);
  border-color: var(--vscode-inputOption-activeBorder);
}

#banner {
  padding: 5px 10px;
  background: var(--vscode-inputValidation-warningBackground);
  border-bottom: 1px solid var(--vscode-inputValidation-warningBorder);
  color: var(--vscode-foreground);
  flex: 0 0 auto;
}

#canvas-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
}

#canvas {
  position: absolute;
  inset: 0;
}

#overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--vscode-editor-background);
  padding: 24px;
  text-align: center;
}

#overlay[hidden] {
  display: none;
}

#overlay-content {
  max-width: 520px;
}

#overlay-content h2 {
  font-size: 15px;
  margin: 0 0 8px;
}

#overlay-content p {
  margin: 0 0 12px;
  color: var(--vscode-descriptionForeground);
  white-space: pre-wrap;
}

#overlay-content button {
  padding: 4px 12px;
  color: var(--vscode-button-foreground);
  background: var(--vscode-button-background);
  border: none;
  border-radius: 3px;
  cursor: pointer;
}

#tooltip {
  position: absolute;
  z-index: 10;
  max-width: 340px;
  padding: 6px 8px;
  background: var(--vscode-editorHoverWidget-background);
  color: var(--vscode-editorHoverWidget-foreground);
  border: 1px solid var(--vscode-editorHoverWidget-border);
  border-radius: 4px;
  font-size: 12px;
  pointer-events: none;
  white-space: pre-wrap;
}

#tooltip[hidden] {
  display: none;
}
```

- [ ] **Step 3: Create `src/controller.ts` with the panel shell**

```ts
import * as vscode from "vscode";
import type { HostToWebview, WebviewToHost } from "./protocol";

export class CallGraphController implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly panelDisposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {}

  async show(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage("Open a Python file first.");
      return;
    }
    this.ensurePanel();
    this.panel?.reveal(undefined, true);
    if (editor.document.languageId !== "python") {
      this.post({ type: "state", state: { kind: "notPython" } });
    }
  }

  private ensurePanel(): void {
    if (this.panel) {
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      "pyCallMap",
      "PyCallMap",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
      }
    );
    this.panel.webview.html = this.getHtml(this.panel.webview);
    this.panelDisposables.push(
      this.panel.onDidDispose(() => {
        this.panel = undefined;
      }),
      this.panel.webview.onDidReceiveMessage((message: WebviewToHost) => {
        if (message?.type === "ready") {
          // Task 7 replaces this stub with the real analysis pipeline.
          this.post({ type: "state", state: { kind: "empty" } });
        }
      })
    );
  }

  private post(message: HostToWebview): void {
    void this.panel?.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "main.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "main.css")
    );
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>PyCallMap</title>
</head>
<body>
  <div id="app">
    <header id="toolbar">
      <span id="title">PyCallMap</span>
      <span id="file"></span>
      <span class="spacer"></span>
      <button id="refresh" title="Refresh">&#x21bb;</button>
      <button id="fit" title="Fit">&#x2922;</button>
      <button id="toggle-uncalled" title="Show uncalled functions">&#x1f441;</button>
    </header>
    <div id="banner" hidden></div>
    <div id="canvas-wrap">
      <div id="canvas"></div>
      <div id="tooltip" hidden></div>
      <div id="overlay">
        <div id="overlay-content"></div>
      </div>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    for (const disposable of this.panelDisposables) {
      disposable.dispose();
    }
    this.panel?.dispose();
    this.panel = undefined;
  }
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let index = 0; index < 32; index += 1) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
```

- [ ] **Step 4: Replace `src/webview/main.ts` with the shell**

```ts
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
```

- [ ] **Step 5: Update `src/extension.ts` to use the controller**

```ts
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
```

- [ ] **Step 6: Build and typecheck**

Run:

```bash
npm run typecheck
npm run build
```

Expected: both exit 0; `media/main.js` and `media/main.css` are generated.

- [ ] **Step 7: Manual verification**

Press F5. Open `examples/demo.py`. Run `PyCallMap: Show Function Call Graph`. Expected: a `PyCallMap` panel opens beside the editor with the toolbar and a `No function definitions found.` message (the analysis pipeline is not wired until Task 7).

- [ ] **Step 8: Commit**

```bash
git add src/controller.ts src/extension.ts src/webview/globals.d.ts src/webview/styles.css src/webview/main.ts
git commit -m "feat(ui): add call graph panel shell"
```

---

### Task 5: Add pure graph data helpers

**Files:**
- Create: `src/webview/graph.ts`
- Create: `test/ts/graph.test.ts`

**Interfaces:**
- Consumes: `AnalyzerResult`, `FunctionNode` from `src/protocol.ts`.
- Produces: `nodeLabel(fn, byId)`, `reachableFromEntries(result)`, `visibleFunctions(result, showUncalled)`, `buildElements(result, showUncalled)`, `findFunctionAtLine(functions, line)`, types `GraphNodeData`, `GraphEdgeData`, `GraphElement`.

- [ ] **Step 1: Write the failing graph helper tests**

`test/ts/graph.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { AnalyzerResult, FunctionNode } from "../../src/protocol";
import {
  buildElements,
  findFunctionAtLine,
  nodeLabel,
  reachableFromEntries,
  visibleFunctions,
} from "../../src/webview/graph";

function fn(overrides: Partial<FunctionNode> & Pick<FunctionNode, "id">): FunctionNode {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    signature: overrides.signature ?? `${overrides.id}()`,
    kind: overrides.kind ?? "function",
    owner: overrides.owner ?? null,
    parent: overrides.parent ?? null,
    line: overrides.line ?? 1,
    endLine: overrides.endLine ?? 1,
    entry: overrides.entry ?? false,
    unused: overrides.unused ?? false,
    externalCalls: overrides.externalCalls ?? 0,
  };
}

function sample(): AnalyzerResult {
  const functions = [
    fn({ id: "main", entry: true, line: 10, endLine: 14 }),
    fn({ id: "a", line: 1, endLine: 3 }),
    fn({ id: "b", line: 5, endLine: 7 }),
    fn({ id: "C.run", name: "run", kind: "method", owner: "C", line: 20, endLine: 22 }),
    fn({ id: "outer", line: 30, endLine: 40 }),
    fn({ id: "outer.inner", name: "inner", kind: "nested", parent: "outer", line: 32, endLine: 34 }),
    fn({ id: "dead", line: 50, endLine: 52, unused: true }),
  ];
  return {
    version: 1,
    file: "/work/app.py",
    functions,
    edges: [
      { id: "e1", source: "main", target: "a", lines: [11, 12], cyclic: false },
      { id: "e2", source: "a", target: "b", lines: [2], cyclic: false },
    ],
    diagnostics: [],
    stats: { functionCount: functions.length, edgeCount: 2, parsedInMs: 1 },
  };
}

describe("nodeLabel", () => {
  const result = sample();
  const byId = new Map(result.functions.map((item) => [item.id, item]));

  it("labels top-level functions", () => {
    expect(nodeLabel(byId.get("a")!, byId)).toBe("a()");
  });

  it("labels methods with the class prefix", () => {
    expect(nodeLabel(byId.get("C.run")!, byId)).toBe("C.run()");
  });

  it("labels nested functions with the parent name", () => {
    expect(nodeLabel(byId.get("outer.inner")!, byId)).toBe("outer › inner()");
  });
});

describe("reachableFromEntries", () => {
  it("walks from entry nodes", () => {
    expect(reachableFromEntries(sample())).toEqual(new Set(["main", "a", "b"]));
  });
});

describe("visibleFunctions", () => {
  it("hides uncalled functions when an entry exists", () => {
    expect(visibleFunctions(sample(), false).map((item) => item.id)).toEqual([
      "main",
      "a",
      "b",
    ]);
  });

  it("shows everything when requested", () => {
    expect(visibleFunctions(sample(), true)).toHaveLength(7);
  });

  it("shows everything when there is no entry", () => {
    const result = sample();
    result.functions = result.functions.map((item) => ({ ...item, entry: false }));
    expect(visibleFunctions(result, false)).toHaveLength(7);
  });
});

describe("buildElements", () => {
  it("filters edges whose endpoints are hidden and labels repeated calls", () => {
    const elements = buildElements(sample(), false);
    const nodes = elements.filter((element) => !("source" in element.data));
    const edges = elements.filter((element) => "source" in element.data);
    expect(nodes).toHaveLength(3);
    expect(edges).toHaveLength(2);
    const mainToA = edges.find(
      (element) => "source" in element.data && element.data.source === "main"
    );
    expect(mainToA && "label" in mainToA.data ? mainToA.data.label : "").toBe("×2");
  });

  it("keeps the unused flag and kind on node data", () => {
    const elements = buildElements(sample(), true);
    const nested = elements.find(
      (element) => "kind" in element.data && element.data.id === "outer.inner"
    );
    expect(nested && "kind" in nested.data ? nested.data.kind : "").toBe("nested");
  });
});

describe("findFunctionAtLine", () => {
  const functions = sample().functions;

  it("prefers the innermost function", () => {
    expect(findFunctionAtLine(functions, 33)?.id).toBe("outer.inner");
  });

  it("finds an outer function", () => {
    expect(findFunctionAtLine(functions, 38)?.id).toBe("outer");
  });

  it("returns undefined outside all functions", () => {
    expect(findFunctionAtLine(functions, 99)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
npm test
```

Expected: failure because `src/webview/graph.ts` does not exist.

- [ ] **Step 3: Create `src/webview/graph.ts`**

```ts
import type { AnalyzerResult, FunctionNode } from "../protocol";

export interface GraphNodeData {
  id: string;
  label: string;
  line: number;
  endLine: number;
  entry: boolean;
  unused: boolean;
  kind: FunctionNode["kind"];
  signature: string;
  externalCalls: number;
}

export interface GraphEdgeData {
  id: string;
  source: string;
  target: string;
  lines: number[];
  cyclic: boolean;
  label: string;
}

export type GraphElement =
  | { data: GraphNodeData }
  | { data: GraphEdgeData };

export function nodeLabel(
  fn: FunctionNode,
  byId: Map<string, FunctionNode>
): string {
  if (fn.kind === "method" && fn.owner) {
    return `${fn.owner}.${fn.name}()`;
  }
  if (fn.kind === "nested" && fn.parent) {
    const parent = byId.get(fn.parent);
    const parentName = parent
      ? parent.kind === "method" && parent.owner
        ? `${parent.owner}.${parent.name}`
        : parent.name
      : fn.parent;
    return `${parentName} › ${fn.name}()`;
  }
  return `${fn.name}()`;
}

export function reachableFromEntries(result: AnalyzerResult): Set<string> {
  const adjacency = new Map<string, string[]>();
  for (const edge of result.edges) {
    const targets = adjacency.get(edge.source) ?? [];
    targets.push(edge.target);
    adjacency.set(edge.source, targets);
  }
  const seen = new Set<string>();
  const stack = result.functions
    .filter((fn) => fn.entry)
    .map((fn) => fn.id);
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    for (const next of adjacency.get(current) ?? []) {
      if (!seen.has(next)) {
        stack.push(next);
      }
    }
  }
  return seen;
}

export function visibleFunctions(
  result: AnalyzerResult,
  showUncalled: boolean
): FunctionNode[] {
  if (showUncalled || !result.functions.some((fn) => fn.entry)) {
    return result.functions;
  }
  const reachable = reachableFromEntries(result);
  return result.functions.filter((fn) => reachable.has(fn.id));
}

export function buildElements(
  result: AnalyzerResult,
  showUncalled: boolean
): GraphElement[] {
  const byId = new Map(result.functions.map((fn) => [fn.id, fn]));
  const visible = visibleFunctions(result, showUncalled);
  const visibleIds = new Set(visible.map((fn) => fn.id));
  const nodes: GraphElement[] = visible.map((fn) => ({
    data: {
      id: fn.id,
      label: nodeLabel(fn, byId),
      line: fn.line,
      endLine: fn.endLine,
      entry: fn.entry,
      unused: fn.unused,
      kind: fn.kind,
      signature: fn.signature,
      externalCalls: fn.externalCalls,
    },
  }));
  const edges: GraphElement[] = result.edges
    .filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target))
    .map((edge) => ({
      data: {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        lines: edge.lines,
        cyclic: edge.cyclic,
        label: edge.lines.length > 1 ? `×${edge.lines.length}` : "",
      },
    }));
  return [...nodes, ...edges];
}

export function findFunctionAtLine(
  functions: FunctionNode[],
  line: number
): FunctionNode | undefined {
  return functions
    .filter((fn) => fn.line <= line && line <= fn.endLine)
    .sort((a, b) => a.endLine - a.line - (b.endLine - b.line))[0];
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run:

```bash
npm test
npm run typecheck
```

Expected: all tests pass; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/webview/graph.ts test/ts/graph.test.ts
git commit -m "feat(ui): add graph data helpers"
```

---

### Task 6: Render the interactive call graph

**Files:**
- Create: `src/webview/cytoscape-dagre.d.ts`
- Replace: `src/webview/main.ts`

**Interfaces:**
- Consumes: `HostToWebview`, `WebviewToHost` from `src/protocol.ts`; `buildElements`, `findFunctionAtLine`, `GraphElement` from `src/webview/graph.ts`.
- Produces: a rendered Cytoscape graph; webview messages `ready`, `jump`, `refresh`, `openSettings`.

- [ ] **Step 1: Create `src/webview/cytoscape-dagre.d.ts`**

```ts
declare module "cytoscape-dagre" {
  import type cytoscape from "cytoscape";

  const extension: (cy: typeof cytoscape) => void;

  export default extension;
}
```

- [ ] **Step 2: Replace `src/webview/main.ts`**

```ts
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
    showTooltip(
      `${data.signature}\nlines ${data.line}-${data.endLine}\nexternal calls: ${data.externalCalls}`,
      event.renderedPosition
    );
  });
  cy.on("mouseout", "node", () => hideTooltip());
  cy.on("mouseover", "edge", (event) => {
    const data = event.target.data();
    showTooltip(
      `${data.source} → ${data.target}\nlines ${(data.lines as number[]).join(", ")}`,
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
      style: graphStyle() as unknown as cytoscape.Stylesheet[],
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
  const target =
    state.cursorLine !== undefined
      ? findFunctionAtLine(state.result.functions, state.cursorLine)
      : undefined;
  cy.nodes().removeClass("cursor");
  if (target) {
    cy.getElementById(target.id).addClass("cursor");
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
    cy.style(graphStyle() as unknown as cytoscape.Stylesheet[]);
  }
});
themeObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });

applyState();
vscode.postMessage({ type: "ready" } satisfies WebviewToHost);
```

- [ ] **Step 3: Build and typecheck**

Run:

```bash
npm run typecheck
npm run build
```

Expected: both exit 0.

- [ ] **Step 4: Manual verification with a temporary graph payload**

The real analysis pipeline arrives in Task 7. To verify rendering now, temporarily replace the `ready` handler body in `src/controller.ts` with the following payload, run F5, open `examples/demo.py`, and run the command:

```ts
if (message?.type === "ready") {
  this.post({
    type: "graph",
    showUncalled: true,
    payload: {
      version: 1,
      file: "/work/demo.py",
      functions: [
        { id: "main", name: "main", signature: "main()", kind: "function", owner: null, parent: null, line: 40, endLine: 44, entry: true, unused: false, externalCalls: 0 },
        { id: "process", name: "process", signature: "process(path)", kind: "function", owner: null, parent: null, line: 25, endLine: 27, entry: false, unused: false, externalCalls: 0 },
        { id: "clean", name: "clean", signature: "clean(text)", kind: "function", owner: null, parent: null, line: 18, endLine: 19, entry: false, unused: false, externalCalls: 0 },
        { id: "factorial", name: "factorial", signature: "factorial(n)", kind: "function", owner: null, parent: null, line: 3, endLine: 6, entry: false, unused: false, externalCalls: 0 },
        { id: "Reporter.__init__", name: "__init__", signature: "__init__(self, name)", kind: "method", owner: "Reporter", parent: null, line: 30, endLine: 32, entry: false, unused: false, externalCalls: 0 },
        { id: "unused_helper", name: "unused_helper", signature: "unused_helper()", kind: "function", owner: null, parent: null, line: 38, endLine: 39, entry: false, unused: true, externalCalls: 0 }
      ],
      edges: [
        { id: "e1", source: "main", target: "process", lines: [42], cyclic: false },
        { id: "e2", source: "main", target: "factorial", lines: [41], cyclic: false },
        { id: "e3", source: "process", target: "clean", lines: [27], cyclic: false },
        { id: "e4", source: "factorial", target: "factorial", lines: [6], cyclic: true },
        { id: "e5", source: "main", target: "Reporter.__init__", lines: [43], cyclic: false }
      ],
      diagnostics: [],
      stats: { functionCount: 6, edgeCount: 5, parsedInMs: 1 }
    }
  });
  return;
}
```

Expected: a left-to-right graph with `main` on the left, a blue entry node, a cyan method border on `Reporter.__init__`, an amber dashed self-loop on `factorial`, and a dashed dimmed `unused_helper`. Clicking a node posts a message; there is no visible jump yet because the controller does not handle it until Task 7. Hovering shows the tooltip. `Fit` works. Wheeling zooms.

- [ ] **Step 5: Revert the temporary payload**

Restore the stub body from Task 4:

```ts
if (message?.type === "ready") {
  this.post({ type: "state", state: { kind: "empty" } });
}
```

Run `npm run build` again.

- [ ] **Step 6: Commit**

```bash
git add src/webview/main.ts src/webview/cytoscape-dagre.d.ts
git commit -m "feat(ui): render the interactive call graph"
```

---

### Task 7: Wire analysis, navigation, settings, and errors

**Files:**
- Create: `src/lineNumbers.ts`
- Create: `test/ts/lineNumbers.test.ts`
- Replace: `src/controller.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `analyzeFile`, `AnalyzerError`, `PythonNotFoundError` from `src/pythonBridge.ts`; `AnalyzerResult`, `HostToWebview`, `WebviewState`, `WebviewToHost` from `src/protocol.ts`; `lineToIndex` from `src/lineNumbers.ts`.
- Produces: the complete `CallGraphController`; `lineToIndex(line)` and `indexToLine(line)`; configuration keys `pyCallMap.pythonPath`, `pyCallMap.autoRefreshOnSave`, `pyCallMap.showUncalledByDefault`.

- [ ] **Step 1: Write the failing line-number tests**

`test/ts/lineNumbers.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { indexToLine, lineToIndex } from "../../src/lineNumbers";

describe("line numbers", () => {
  it("converts 1-based lines to 0-based indexes", () => {
    expect(lineToIndex(1)).toBe(0);
    expect(lineToIndex(42)).toBe(41);
    expect(lineToIndex(0)).toBe(0);
  });

  it("converts 0-based indexes to 1-based lines", () => {
    expect(indexToLine(0)).toBe(1);
    expect(indexToLine(41)).toBe(42);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
npm test
```

Expected: failure because `src/lineNumbers.ts` does not exist.

- [ ] **Step 3: Create `src/lineNumbers.ts`**

```ts
export function lineToIndex(line: number): number {
  return Math.max(0, line - 1);
}

export function indexToLine(index: number): number {
  return index + 1;
}
```

- [ ] **Step 4: Replace `src/controller.ts`**

```ts
import * as vscode from "vscode";
import { spawn as nodeSpawn } from "node:child_process";
import * as fs from "node:fs";
import { analyzeFile, AnalyzerError, PythonNotFoundError } from "./pythonBridge";
import { lineToIndex } from "./lineNumbers";
import type {
  AnalyzerResult,
  HostToWebview,
  WebviewState,
  WebviewToHost,
} from "./protocol";

interface CacheEntry {
  mtimeMs: number;
  result: AnalyzerResult;
}

export class CallGraphController implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private panelReady = false;
  private panelDisposables: vscode.Disposable[] = [];
  private boundUri: vscode.Uri | undefined;
  private boundDocument: vscode.TextDocument | undefined;
  private lastResult: AnalyzerResult | undefined;
  private currentState: WebviewState | undefined;
  private analysisGeneration = 0;
  private analysisAbort: AbortController | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  private cursorTimer: NodeJS.Timeout | undefined;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly output = vscode.window.createOutputChannel("PyCallMap");

  constructor(private readonly context: vscode.ExtensionContext) {}

  async show(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage("Open a Python file first.");
      return;
    }
    this.ensurePanel();
    this.panel?.reveal(undefined, true);
    if (editor.document.languageId !== "python") {
      this.postState({ kind: "notPython" });
      return;
    }
    this.bind(editor.document);
    await this.refresh(true);
  }

  private ensurePanel(): void {
    if (this.panel) {
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      "pyCallMap",
      "PyCallMap",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
      }
    );
    this.panel.webview.html = this.getHtml(this.panel.webview);
    this.panelDisposables.push(
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.panelReady = false;
        this.disposeListeners();
      }),
      this.panel.webview.onDidReceiveMessage((message: WebviewToHost) => {
        void this.onMessage(message);
      }),
      vscode.window.onDidChangeTextEditorSelection((event) => this.onSelectionChanged(event)),
      vscode.window.onDidChangeActiveTextEditor((editor) => this.onActiveEditorChanged(editor)),
      vscode.workspace.onDidSaveTextDocument((document) => this.onSaved(document)),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("pyCallMap")) {
          this.cache.clear();
          if (this.boundDocument) {
            void this.refresh(true);
          }
        }
      })
    );
  }

  private bind(document: vscode.TextDocument): void {
    if (this.boundUri?.toString() !== document.uri.toString()) {
      this.lastResult = undefined;
      this.currentState = undefined;
    }
    this.boundDocument = document;
    this.boundUri = document.uri;
  }

  private async onMessage(message: WebviewToHost): Promise<void> {
    if (!message || typeof message !== "object") {
      return;
    }
    switch (message.type) {
      case "ready":
        this.panelReady = true;
        if (this.currentState) {
          this.post({ type: "state", state: this.currentState });
        } else if (this.lastResult) {
          this.postGraph(this.lastResult);
        }
        break;
      case "jump":
        await this.jump(message.line);
        break;
      case "refresh":
        await this.refresh(true);
        break;
      case "openSettings":
        await vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "pyCallMap.pythonPath"
        );
        break;
    }
  }

  private post(message: HostToWebview): void {
    if (this.panel && this.panelReady) {
      void this.panel.webview.postMessage(message);
    }
  }

  private postState(state: WebviewState): void {
    this.currentState = state;
    this.post({ type: "state", state });
  }

  private postGraph(result: AnalyzerResult): void {
    this.currentState = undefined;
    const configuration = vscode.workspace.getConfiguration("pyCallMap");
    const showUncalled = configuration.get<boolean>("showUncalledByDefault", false);
    const warning =
      result.stats.functionCount > 300
        ? "Large graph: consider hiding uncalled functions."
        : undefined;
    this.post({ type: "graph", payload: result, showUncalled, warning });
  }

  private renderResult(result: AnalyzerResult): void {
    const errorDiagnostic = result.diagnostics.find((item) => item.severity === "error");
    if (errorDiagnostic) {
      this.lastResult = undefined;
      const detail =
        errorDiagnostic.line > 0
          ? `Line ${errorDiagnostic.line}: ${errorDiagnostic.message}`
          : errorDiagnostic.message;
      this.postState({
        kind: "error",
        title: "Syntax error",
        detail,
        canOpenSettings: false,
      });
      return;
    }
    if (result.functions.length === 0) {
      this.lastResult = undefined;
      this.postState({ kind: "empty" });
      return;
    }
    this.lastResult = result;
    this.postGraph(result);
  }

  private async refresh(force: boolean): Promise<void> {
    if (!this.panel) {
      return;
    }
    const document = this.boundDocument;
    if (!document) {
      return;
    }
    if (document.languageId !== "python") {
      this.postState({ kind: "notPython" });
      return;
    }
    let mtimeMs: number;
    try {
      const stat = await vscode.workspace.fs.stat(document.uri);
      mtimeMs = stat.mtime;
    } catch (error) {
      this.postState({
        kind: "error",
        title: "File unavailable",
        detail: String(error),
        canOpenSettings: false,
      });
      return;
    }
    const cacheKey = document.uri.fsPath;
    const cached = this.cache.get(cacheKey);
    if (!force && cached && cached.mtimeMs === mtimeMs) {
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, cached);
      this.renderResult(cached.result);
      return;
    }
    const generation = ++this.analysisGeneration;
    this.analysisAbort?.abort();
    const abortController = new AbortController();
    this.analysisAbort = abortController;
    this.postState({ kind: "loading" });
    try {
      const result = await analyzeFile(
        document.uri.fsPath,
        {
          platform: process.platform,
          pathExists: (candidate) => fs.existsSync(candidate),
          workspaceFolder: vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath,
          pythonPathSetting: vscode.workspace
            .getConfiguration("pyCallMap")
            .get<string>("pythonPath", ""),
        },
        this.context.asAbsolutePath("python/analyze.py"),
        {
          spawn: nodeSpawn,
          timeoutMs: 5000,
          maxOutputBytes: 10 * 1024 * 1024,
          signal: abortController.signal,
        }
      );
      if (generation !== this.analysisGeneration) {
        return;
      }
      this.cache.set(cacheKey, { mtimeMs, result });
      this.trimCache();
      this.renderResult(result);
    } catch (error) {
      if (generation !== this.analysisGeneration || abortController.signal.aborted) {
        return;
      }
      this.reportAnalysisError(error);
    }
  }

  private trimCache(): void {
    while (this.cache.size > 5) {
      const first = this.cache.keys().next();
      if (first.done) {
        break;
      }
      this.cache.delete(first.value);
    }
  }

  private reportAnalysisError(error: unknown): void {
    this.lastResult = undefined;
    if (error instanceof PythonNotFoundError) {
      this.output.appendLine(`[error] ${error.message}`);
      this.postState({
        kind: "error",
        title: "Python interpreter not found",
        detail:
          "Set pyCallMap.pythonPath to a Python executable, or create a .venv in the workspace.",
        canOpenSettings: true,
      });
      return;
    }
    const analyzerError =
      error instanceof AnalyzerError ? error : new AnalyzerError(String(error));
    this.output.appendLine(`[error] ${analyzerError.message}`);
    if (analyzerError.detail) {
      this.output.appendLine(analyzerError.detail);
    }
    const tail = analyzerError.detail
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .slice(-5)
      .join("\n");
    this.postState({
      kind: "error",
      title: analyzerError.message,
      detail: tail,
      canOpenSettings: false,
    });
  }

  private onSaved(document: vscode.TextDocument): void {
    if (!this.panel || !this.boundUri) {
      return;
    }
    if (document.uri.toString() !== this.boundUri.toString()) {
      return;
    }
    if (!vscode.workspace.getConfiguration("pyCallMap").get<boolean>("autoRefreshOnSave", true)) {
      return;
    }
    this.scheduleRefresh();
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh(false);
    }, 300);
  }

  private onActiveEditorChanged(editor: vscode.TextEditor | undefined): void {
    if (!this.panel || !editor) {
      return;
    }
    if (editor.document.languageId !== "python") {
      return;
    }
    if (this.boundUri && editor.document.uri.toString() === this.boundUri.toString()) {
      if (this.lastResult) {
        this.postGraph(this.lastResult);
      }
      return;
    }
    this.bind(editor.document);
    void this.refresh(false);
  }

  private onSelectionChanged(event: vscode.TextEditorSelectionChangeEvent): void {
    if (!this.panel || !this.boundUri) {
      return;
    }
    if (event.textEditor.document.uri.toString() !== this.boundUri.toString()) {
      return;
    }
    if (this.cursorTimer) {
      clearTimeout(this.cursorTimer);
    }
    this.cursorTimer = setTimeout(() => {
      this.cursorTimer = undefined;
      const line = event.selections[0]?.active.line ?? 0;
      this.post({ type: "cursor", line: line + 1 });
    }, 100);
  }

  private async jump(line1Based: number): Promise<void> {
    if (!this.boundUri) {
      return;
    }
    let document = this.boundDocument;
    if (!document || document.uri.toString() !== this.boundUri.toString()) {
      document = await vscode.workspace.openTextDocument(this.boundUri);
    }
    const visibleEditor = vscode.window.visibleTextEditors.find(
      (editor) => editor.document.uri.toString() === this.boundUri?.toString()
    );
    const line = lineToIndex(line1Based);
    const position = new vscode.Position(line, 0);
    const selection = new vscode.Range(position, position);
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: visibleEditor?.viewColumn ?? vscode.ViewColumn.One,
      selection,
      preserveFocus: false,
    });
    editor.revealRange(selection, vscode.TextEditorRevealType.InCenter);
  }

  private disposeListeners(): void {
    for (const disposable of this.panelDisposables) {
      disposable.dispose();
    }
    this.panelDisposables = [];
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    if (this.cursorTimer) {
      clearTimeout(this.cursorTimer);
      this.cursorTimer = undefined;
    }
    this.analysisAbort?.abort();
    this.analysisAbort = undefined;
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "main.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "main.css")
    );
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>PyCallMap</title>
</head>
<body>
  <div id="app">
    <header id="toolbar">
      <span id="title">PyCallMap</span>
      <span id="file"></span>
      <span class="spacer"></span>
      <button id="refresh" title="Refresh">&#x21bb;</button>
      <button id="fit" title="Fit">&#x2922;</button>
      <button id="toggle-uncalled" title="Show uncalled functions">&#x1f441;</button>
    </header>
    <div id="banner" hidden></div>
    <div id="canvas-wrap">
      <div id="canvas"></div>
      <div id="tooltip" hidden></div>
      <div id="overlay">
        <div id="overlay-content"></div>
      </div>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.disposeListeners();
    this.panel?.dispose();
    this.panel = undefined;
    this.output.dispose();
  }
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let index = 0; index < 32; index += 1) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
```

- [ ] **Step 5: Add the configuration contribution to `package.json`**

Add this `configuration` property inside `contributes`, after the `menus` property (remember the comma after the closing brace of `menus`):

```json
"configuration": {
  "title": "PyCallMap",
  "properties": {
    "pyCallMap.pythonPath": {
      "type": "string",
      "default": "",
      "description": "Path to the Python interpreter. Leave empty to auto-detect .venv or PATH."
    },
    "pyCallMap.autoRefreshOnSave": {
      "type": "boolean",
      "default": true,
      "description": "Refresh the call graph when the bound Python file is saved."
    },
    "pyCallMap.showUncalledByDefault": {
      "type": "boolean",
      "default": false,
      "description": "Show functions that are unreachable from any entry point when the panel opens."
    }
  }
}
```

- [ ] **Step 6: Run tests, typecheck, and build**

Run:

```bash
npm test
npm run typecheck
npm run build
```

Expected: all tests pass; typecheck and build exit 0.

- [ ] **Step 7: Manual verification**

Press F5 and open `examples/demo.py`. Run the command.

Verify all of the following:

1. The graph appears beside the editor, left to right.
2. `main` is blue and `factorial` has an amber dashed self-loop.
3. Clicking `process` jumps to its definition and centers it.
4. Clicking the `main → process` edge jumps to the call site line in `main`.
5. Moving the cursor inside `clean` highlights the `clean` node.
6. Saving the file refreshes the graph without creating a second panel.
7. Switching to another Python file updates the graph; switching to a non-Python file keeps the graph.
8. Hovering a node shows its signature, line range, and external call count.
9. `Fit` resets the viewport; the eye button shows/hides `unused_helper`.
10. Switching between light and dark themes re-colors the graph.

- [ ] **Step 8: Manual error-state verification**

1. Introduce `def broken(:` into a temporary `.py` file, open it, and run the command. Expected: red overlay titled `Syntax error` with the line number.
2. Run `PyCallMap: Show Function Call Graph` from a Markdown file. Expected: `Current file is not a Python file.`
3. Set `pyCallMap.pythonPath` to `/nonexistent/python`, restart the Extension Development Host, and run the command. Expected: `Python interpreter not found` with an `Open Settings` button.
4. Open a file with no functions. Expected: `No function definitions found.`

- [ ] **Step 9: Commit**

```bash
git add src/controller.ts src/lineNumbers.ts test/ts/lineNumbers.test.ts package.json package-lock.json
git commit -m "feat: wire analysis, navigation, and settings"
```

---

### Task 8: Add documentation, CI, and packaging

**Files:**
- Create: `LICENSE`
- Create: `README.md`
- Create: `CHANGELOG.md`
- Create: `.github/workflows/ci.yml`
- Create: `media/icon.svg` (source asset)
- Modify: `package.json` (icon field, only after `media/icon.png` exists)

**Interfaces:**
- Consumes: the working extension from Tasks 1–7.
- Produces: a `.vsix` that installs in a clean VSCode profile; a CI workflow that runs TypeScript and Python tests on Ubuntu and Windows.

- [ ] **Step 1: Create `LICENSE`**

```
MIT License

Copyright (c) 2026 PyCallMap contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 2: Create `README.md`**

```markdown
# PyCallMap

把 Python 文件里的函数调用关系画成一张横向调用图，点击节点即可跳到对应代码。

PyCallMap visualizes the function call graph of a single Python file as an
interactive left-to-right diagram. Click a node to jump to its definition.

![PyCallMap screenshot](media/screenshot.png)

## 功能

- 横向有向调用图，每个函数只出现一次
- 递归和互相调用用琥珀色虚线回边表示
- 顶层函数、类方法、嵌套函数
- 自动识别入口（模块级调用、`if __name__ == "__main__":`、`main`）
- 未调用函数默认隐藏，可一键显示
- 点击节点跳到函数定义，点击边跳到调用位置
- 光标移动时高亮当前函数
- 保存文件自动刷新
- 跟随 VSCode 深色/浅色主题
- 所有分析在本地完成，无网络请求、无遥测

## 安装

### 从 VSIX 安装

1. 下载发布附件中的 `.vsix` 文件。
2. 在 VSCode 中打开扩展视图，点击右上角 `...`，选择 `Install from VSIX...`。
3. 选择下载的 `.vsix` 文件。

### 开发模式

```bash
npm install
npm run build
```

在 VSCode 中按 F5 启动 Extension Development Host。

## 使用

1. 打开一个 `.py` 文件。
2. 执行命令 `PyCallMap: Show Function Call Graph`，或点击编辑器标题栏的图图标。
3. 在右侧面板查看调用图。

## 支持的写法

- 同一文件内的顶层函数、类方法、嵌套函数
- `self.foo()`、`cls.foo()`、`ClassName.foo()`、无参 `super().foo()`
- 同一文件内的类继承
- `ClassName()` 和类方法里的 `cls()` 会连到 `__init__`
- 递归、互相调用
- `async def`

## 已知限制

- 只分析当前文件，不追踪 import 或其他文件
- 不做局部变量类型推断，所以 `obj = MyClass(); obj.foo()` 不会连边
- 不解析函数别名、`getattr`、`eval`、回调注册、装饰器内部调用
- 多继承使用同文件父类的深度优先近似，不保证精确 MRO
- 被跳过的调用会计入所在函数的「外部调用」数量

## 设置

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `pyCallMap.pythonPath` | `""` | 指定 Python 解释器；留空时自动查找 `.venv` 和 PATH |
| `pyCallMap.autoRefreshOnSave` | `true` | 保存绑定的 Python 文件时自动刷新 |
| `pyCallMap.showUncalledByDefault` | `false` | 首次打开时显示不可达函数 |

## 隐私

PyCallMap 只读取当前 Python 文件并在本地运行标准库分析脚本。它不发送任何数据，不包含遥测，也不执行用户代码。

## 开发

```bash
npm run typecheck
npm test
python -m unittest discover -s test/python -p "test_*.py" -v
npm run build
npm run package
```

## English summary

PyCallMap renders a single Python file's function call graph as an interactive
left-to-right diagram. It supports top-level functions, methods, nested
functions, recursion, entry detection, click-to-code navigation, and cursor
highlighting. Analysis runs locally with Python's standard library; no code is
executed and no data leaves the machine.

## License

MIT
```

- [ ] **Step 3: Create `CHANGELOG.md`**

```markdown
# Changelog

## 0.1.0 - 2026-10-17

- Initial release.
- Left-to-right interactive call graph for a single Python file.
- Top-level functions, class methods, and nested functions.
- Recursion and mutual recursion rendered as dashed back edges.
- Entry detection, unreachable-function filter, and external-call counts.
- Click-to-code navigation, edge-to-call-site navigation, cursor highlighting.
- Auto-refresh on save, theme support, and friendly error states.
```

- [ ] **Step 4: Create `.github/workflows/ci.yml`**

```yaml
name: ci

on:
  push:
  pull_request:

jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest]
        python: ["3.10", "3.11", "3.12"]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - uses: actions/setup-python@v5
        with:
          python-version: ${{ matrix.python }}
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: python -m unittest discover -s test/python -p "test_*.py" -v
      - run: npm run build
      - run: npx vsce package --no-dependencies
      - uses: actions/upload-artifact@v4
        with:
          name: vsix-${{ matrix.os }}-py${{ matrix.python }}
          path: "*.vsix"
```

- [ ] **Step 5: Create `media/icon.svg`**

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="20" fill="#1e1e1e"/>
  <rect x="10" y="52" width="34" height="24" rx="5" fill="#1f3a4d" stroke="#569cd6" stroke-width="2"/>
  <rect x="82" y="18" width="36" height="22" rx="5" fill="#2d2d30" stroke="#3c3c3c" stroke-width="2"/>
  <rect x="82" y="53" width="36" height="22" rx="5" fill="#2d2d30" stroke="#4ec9b0" stroke-width="2"/>
  <rect x="82" y="88" width="36" height="22" rx="5" fill="#2d2d30" stroke="#c586c0" stroke-width="2"/>
  <path d="M44 60 L82 30" stroke="#8a8a8a" stroke-width="2.5" fill="none"/>
  <path d="M44 64 L82 64" stroke="#8a8a8a" stroke-width="2.5" fill="none"/>
  <path d="M44 68 L82 98" stroke="#8a8a8a" stroke-width="2.5" fill="none"/>
  <path d="M82 30 L76 34 L80 38 Z" fill="#8a8a8a"/>
  <path d="M82 64 L76 60 L76 68 Z" fill="#8a8a8a"/>
  <path d="M82 98 L76 90 L80 94 Z" fill="#8a8a8a"/>
</svg>
```

- [ ] **Step 6: Export the icon**

Export `media/icon.svg` to `media/icon.png` at 128×128 using any image editor or an online SVG-to-PNG converter. Then add this property to `package.json` next to `"license"`:

```json
"icon": "media/icon.png",
```

If the export cannot be done, skip this step; the `.vsix` still installs, but the Marketplace listing will not have a custom icon.

- [ ] **Step 7: Capture a screenshot**

Run the extension in the Extension Development Host on `examples/demo.py`, open
the call graph panel, and capture it at roughly 900×600. Save the image as
`media/screenshot.png`. The README references this file, and `.vscodeignore`
does not exclude it, so it ships with the extension.

- [ ] **Step 8: Run the full verification suite**

Run:

```bash
npm run typecheck
npm test
python -m unittest discover -s test/python -p "test_*.py" -v
npm run build
npm run package
```

Expected: all tests pass; `npm run package` creates `py-call-map-0.1.0.vsix`.

Then verify the analysis performance target from the spec (under 1 second for
200 functions):

```bash
python -c "from pathlib import Path; Path('large_sample.py').write_text('\n'.join(f'def f{i}():\n    f{(i+1)%200}()' for i in range(200)), encoding='utf-8')"
python -I python/analyze.py --file large_sample.py | python -c "import json,sys; print(json.load(sys.stdin)['stats']['parsedInMs'])"
rm large_sample.py
```

Expected: a number below `1000`.

- [ ] **Step 9: Install and verify the VSIX in a clean profile**

1. Open a new VSCode window with an empty profile (`code --user-data-dir <temp> --extensions-dir <temp>`).
2. Install the generated `.vsix` via `Extensions: Install from VSIX...`.
3. Open `examples/demo.py` and run `PyCallMap: Show Function Call Graph`.
4. Verify the acceptance items from the spec: graph renders, node/edge jumps work, cursor highlighting works, save refresh works, error states appear, and the panel is reused.

- [ ] **Step 10: Commit**

```bash
git add LICENSE README.md CHANGELOG.md .github/workflows/ci.yml media/icon.svg media/screenshot.png package.json
git commit -m "chore: add docs, CI, and packaging"
```

If `media/icon.png` was created, add it to the same commit:

```bash
git add media/icon.png
git commit --amend --no-edit
```

**Before publishing:** change `"publisher": "local-dev"` in `package.json` to
your Marketplace publisher ID, confirm the `PyCallMap` display name is
available, add the `"repository"` URL, then run `npx vsce publish`.

---

## Self-Review

- Spec coverage: analyzer rules (Task 2, including class-body, lambda, and type-annotation cases), data contract (Task 3), panel and UI (Tasks 4–6), controller/settings/errors (Task 7), tests and CI (Tasks 2, 3, 5, 7, 8), packaging, screenshot, and release checklist (Task 8), security/privacy (no execution; README).
- Placeholders: none; every code step contains the actual code.
- Type consistency: `AnalyzerResult`/`FunctionNode`/`CallEdge` are used identically in Tasks 2, 3, 5, 6, 7; `analyzeFile`, `runAnalyzer`, `buildElements`, `findFunctionAtLine`, `lineToIndex` keep their names and signatures across tasks.
- Out of scope for this plan: runtime tracing (M4), cross-file analysis, multi-language support.
