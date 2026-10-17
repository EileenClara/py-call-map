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
