# Changelog

## 0.2.3 - 2026-10-18

- Render the editor title action as an icon (`$(graph)`) instead of text.
- Detect notebooks from the active tab when `activeNotebookEditor` is unavailable.

## 0.2.2 - 2026-10-18

- Rewrite the README and Marketplace listing in English.

## 0.2.1 - 2026-10-18

- Shorten the command title to `PyCallMap`.

## 0.2.0 - 2026-10-17

- Analyze a Jupyter notebook (`.ipynb`) as one program across all code cells.
- Cross-cell edges, cell-aware tooltips (`Cell N · line M`).
- Click a node or edge to jump to the owning cell; the active cell's functions are highlighted.
- Notebook toolbar button; notebooks re-analyze on change.

## 0.1.0 - 2026-10-17

- Initial release.
- Left-to-right interactive call graph for a single Python file.
- Top-level functions, class methods, and nested functions.
- Recursion and mutual recursion rendered as dashed back edges.
- Entry detection, unreachable-function filter, and external-call counts.
- Click-to-code navigation, edge-to-call-site navigation, cursor highlighting.
- Auto-refresh on save, theme support, and friendly error states.
