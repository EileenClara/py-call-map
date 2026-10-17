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
