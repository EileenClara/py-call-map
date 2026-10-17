# PyCallMap：Python 函数调用图 VSCode 扩展设计

- 日期：2026-10-17
- 状态：待实现
- 暂定名称：PyCallMap（扩展 ID `py-call-map`，命令与配置命名空间 `pyCallMap`）

## 1. 背景与目标

初学者阅读一个 Python 文件时，常见结构是：文件顶部定义许多函数，文件底部由 `main()` 或 `if __name__ == "__main__":` 统一调用。读者需要反复上下翻找，很难在脑中建立"谁调用了谁、从哪里进入"的整体图景。

本扩展在 VSCode 编辑器中打开一个横向函数调用图，帮助用户：

1. 一眼看到函数之间的调用关系、入口、未被调用的函数；
2. 点击节点跳到对应函数定义；
3. 编辑器光标移动时，图上高亮当前所在函数。

目标用户是 Python 初学者和阅读他人代码的开发者。

## 2. 范围

### 2.1 MVP（第一版）包含

- 单个 Python 文件内的静态分析，不运行代码。
- 节点：顶层函数、类方法、嵌套函数。
- 边：同文件内可解析的直接调用；递归、互相调用形成的环用回边表示。
- 横向（从左到右）有向图，节点去重，不为同一条调用路径重复建节点。
- 点击节点跳转到函数定义；点击边跳转到调用点。
- 光标位置与图上节点联动（光标 → 高亮节点）。
- 保存、切换文件、手动刷新时更新。
- 入口识别、未调用函数过滤、外部调用计数。
- 异常状态提示、深浅色主题适配。
- 单元测试、CI、可打包发布的工程结构。

### 2.2 MVP 不包含

- 跨文件/跨模块的调用与跳转。
- 运行时执行轨迹（见 2.3）。
- Python 以外的语言。
- 局部变量的类型推断（`obj = MyClass(); obj.foo()` 不解析）。
- 函数别名、回调注册、`getattr`/`eval` 等动态调用。
- 导出图片、搜索框、自定义布局、折叠节点、类分组大框。
- 键盘无障碍导航（canvas 图的无障碍支持留待后续）。

### 2.3 后续里程碑

- M4：运行时轨迹叠加。用户显式点击"运行并追踪"后，用 `sys.settrace` 记录真实调用顺序，在图上的对应边上按顺序高亮。该功能会执行用户代码，必须单独设计安全确认流程，另写 spec。
- 跨文件静态分析。
- 多语言（Tree-sitter）。

## 3. 术语

- **入口（entry）**：模块导入时会被执行的调用所指向的函数，或回退规则下的 `main`。
- **可达（reachable）**：从任一入口沿调用边能到达。
- **未调用（unused）**：存在入口时，从所有入口都不可达的函数。没有入口时，所有函数的 `unused` 均为 `false`。
- **外部调用（external call）**：无法解析到当前文件内函数的调用。
- **回边（cyclic edge）**：位于环上的调用边（含自环）。

## 4. 架构

### 4.1 组件

```
┌────────────────── VSCode 扩展进程（Node/TS） ──────────────────┐
│ extension.ts      激活、命令注册、WebviewPanel 生命周期          │
│ controller.ts     绑定文件、刷新调度、跳转、光标同步、缓存        │
│ pythonBridge.ts   解释器发现、spawn、超时、JSON 收发与校验        │
│ protocol.ts       扩展 ↔ webview 的消息类型、AnalyzerResult 类型  │
└──────────────┬──────────────────────────────▲──────────────────┘
               │ 子进程 stdout(JSON)           │ postMessage
               ▼                              │
      python/analyze.py                webview/main.ts
      标准库 ast 解析                   Cytoscape + dagre 渲染
```

### 4.2 模块职责

- `python/analyze.py`：只读取一个 .py 文件，输出固定 JSON。只使用 Python 标准库（`ast`、`json`、`tokenize`、`sys`、`argparse`），不依赖第三方包。
- `pythonBridge.ts`：按优先级寻找解释器，启动子进程，处理超时/退出码/stderr，校验并返回 JSON。不使用 shell，参数以数组传递。
- `controller.ts`：决定何时分析（打开面板、切换 Python 编辑器、保存、手动刷新），维护"面板绑定的文件"，执行跳转和光标同步，按文件 mtime 缓存结果。
- `extension.ts`：注册命令、创建/复用面板、把 controller 与 webview 连起来。
- `webview/main.ts`：只消费 JSON、渲染和发送用户操作消息，不读文件、不解析 Python。

### 4.3 数据流

1. 用户执行 `PyCallMap: Show Function Call Graph`，或面板已打开时切换到另一个 Python 文件。
2. `controller` 取文档 URI 与绝对路径，若缓存命中（同路径且 mtime 未变）直接复用。
3. 否则 `pythonBridge` 执行：
   `spawn(pythonPath, ["-I", "<extension>/python/analyze.py", "--file", "<abs path>"])`
4. `analyze.py` 输出 JSON；`controller` 校验后 `postMessage({type:"graph", payload})`。
5. `webview` 用 dagre 做 LR 布局，Cytoscape 渲染。
6. 点击节点 → `{type:"jump", line}` → 扩展在代码所在编辑器组中打开并 `revealRange`。
7. 光标移动 → 扩展节流发送 `{type:"cursor", line}` → webview 高亮包含该行的最内层函数。

## 5. 分析器规格

### 5.1 输入与输出

- 输入：`--file <绝对路径>`。
- 输出：UTF-8 JSON 到 stdout。分析器启动时执行 `sys.stdout.reconfigure(encoding="utf-8")`，避免 Windows 默认编码问题（`-I` 会忽略 `PYTHONIOENCODING`，因此在脚本内处理）。
- 源码读取使用 `tokenize.open()`，遵守 PEP 263 编码声明与 BOM。
- 解析失败时仍输出合法 JSON，包含 `diagnostics` 与空的 `functions`/`edges`，退出码为 0；只有分析器自身崩溃才使用非零退出码。

### 5.2 符号表与节点

1. 顶层 `def` / `async def`：节点 ID 为函数名。
2. 类（`class`）内定义的方法：节点 ID 为 `ClassName.method`。类本身不建节点。
3. 嵌套函数：节点 ID 为完整作用域路径，如 `outer.inner`、`MyClass.method.inner`。
4. 重复定义（同名函数/方法/同父作用域同名嵌套函数）：按 Python 运行时语义取**最后一次**定义，并在 `diagnostics` 中给出 warning，忽略更早的定义。
5. 每个节点记录：`id`、`name`、`kind`（`function`/`method`/`nested`）、`owner`（方法所属类，其他为 null）、`parent`（嵌套函数的直接父级 ID，其他为 null）、`signature`（如 `foo(a, b=None)`）、`line`、`endLine`、`entry`、`unused`、`externalCalls`。
6. 行号从 1 开始；`endLine` 取自 `ast` 的 `end_lineno`。

### 5.3 调用解析规则

对函数/方法体内的每个 `ast.Call`，按以下顺序解析目标：

1. `foo()`（`ast.Name`）：
   - 在当前作用域链中查找嵌套函数（由内向外）；
   - 再查找顶层函数；
   - 都没有 → 外部调用。
2. `self.foo()` / `cls.foo()`（方法内）：
   - 在当前类查找方法；
   - 再按定义顺序深度优先查找同文件内定义的父类（近似 MRO，不支持 C3 精确顺序）；
   - 都没有 → 外部调用。
3. `super().foo()`：在父类链中解析（仅支持无参 `super()`）。
4. `ClassName.foo()`：在该类及其同文件父类中查找方法。
5. `ClassName()`（类实例化）：
   - 若 `ClassName` 是文件内定义的类，且存在 `__init__`，连边到 `ClassName.__init__`；
   - 内部类无 `__init__` 时不连边，也**不**计外部调用；
   - 若 `ClassName` 是导入的外部类 → 外部调用。
6. 其他情况（属性调用、局部变量调用、别名、动态调用）→ 外部调用，`externalCalls += 1`。

遍历采用作用域感知的 visitor：

- 进入嵌套 `def` 时创建节点并压入作用域栈，其函数体内的调用归属该嵌套函数，不归属外层。
- 跳过装饰器表达式与参数默认值中的调用（它们在定义期执行）。
- 跳过类型注解中的调用。
- 函数体内的任意嵌套结构（if/for/while/try/with/match、lambda、推导式）中的调用都归属当前函数。
- 只统计 `ast.Call`；`@property` 的访问不是调用，不连边。

### 5.4 入口与可达性

1. 扫描模块顶层语句，跳过所有 `FunctionDef`/`AsyncFunctionDef`/`ClassDef` 的函数体，收集会执行的 `ast.Call`，解析出的内部函数即入口。`if __name__ == "__main__":` 块中的调用自然也属于模块级，无需特殊分支。
2. 若步骤 1 没有找到任何内部入口，且存在名为 `main` 的函数，则 `main` 为入口。
3. 若仍没有入口：`entries = []`，所有节点的 `entry=false`、`unused=false`，前端显示全部函数。
4. 有入口时：从入口沿边做可达性搜索，不可达节点标记 `unused=true`。

### 5.5 环标记

- 对调用图做 Tarjan 强连通分量。
- 自环边标记 `cyclic=true`。
- 同一 SCC 内（且 SCC 大小 > 1）的边标记 `cyclic=true`。
- 其余边 `cyclic=false`。

### 5.6 边聚合

- 同一 `(source, target)` 的多条调用合并为一条边。
- `lines` 记录所有调用点行号（升序、去重）。
- 前端在 `lines.length > 1` 时显示 `×N`，悬停列出全部行号；点击跳转到 `lines[0]`。

### 5.7 明确不支持的写法（均按外部调用处理，除非另有说明）

- 跨文件/导入的函数与类。
- 局部变量类型推断：`obj = MyClass(); obj.foo()`。
- 函数别名：`f = foo; f()`。
- 动态调用：`getattr`、`eval`、回调注册、装饰器内部调用。
- 参数默认值与装饰器中的调用（跳过，不计外部调用）。
- 多继承的精确 MRO（使用同文件父类深度优先近似）。
- 类体语句中的调用（不计入口）。

### 5.8 错误处理

- `SyntaxError`：`diagnostics` 返回 `severity="error"`、`message`、`line`、`column`，函数与边为空。
- 文件读取失败：返回 error diagnostic，消息包含系统错误信息。
- 分析器内部异常：捕获后输出 `diagnostics`（error）并正常退出；traceback 写 stderr，供扩展在超时/失败时显示末尾内容。

## 6. 数据契约

扩展与 webview 共用的 `AnalyzerResult`：

```json
{
  "version": 1,
  "file": "C:/project/app.py",
  "functions": [
    {
      "id": "main",
      "name": "main",
      "signature": "main()",
      "kind": "function",
      "owner": null,
      "parent": null,
      "line": 14,
      "endLine": 17,
      "entry": true,
      "unused": false,
      "externalCalls": 2
    },
    {
      "id": "MyClass.run",
      "name": "run",
      "signature": "run(self, x, y=None)",
      "kind": "method",
      "owner": "MyClass",
      "parent": null,
      "line": 30,
      "endLine": 36,
      "entry": false,
      "unused": true,
      "externalCalls": 0
    }
  ],
  "edges": [
    {
      "id": "e1",
      "source": "main",
      "target": "factorial",
      "lines": [15, 16],
      "cyclic": false
    }
  ],
  "diagnostics": [
    { "severity": "warning", "message": "重复定义 foo，使用第 42 行的定义", "line": 10, "column": 0 }
  ],
  "stats": { "functionCount": 2, "edgeCount": 1, "parsedInMs": 12 }
}
```

- 行号均为 1-based。扩展在跳转时统一转换为 VSCode 的 0-based `Position.line`，只在 `controller.ts` 中转换一次。
- 扩展对 JSON 做结构校验；缺少必填字段或版本不匹配时按"分析器输出无效"处理。

## 7. UI 规格

### 7.1 面板

- 使用 `WebviewPanel`，打开在 `ViewColumn.Beside`（代码右侧分栏），标题 `PyCallMap`。
- 首次打开时 `preserveFocus: true`，不抢走编辑器焦点。
- 重复执行命令时 `reveal()` 已有面板；同一时间只存在一个面板。
- 面板关闭后停止监听保存/光标事件，下次打开重新创建。

### 7.2 工具栏

左上角文件名，右侧三个按钮（英文文案）：

- `Refresh`：强制重新分析，忽略缓存。
- `Fit`：图适应窗口。
- `Show uncalled`：切换是否显示不可达函数（默认关闭）。
- 按钮使用 VSCode 主题色，带 `title` 提示。

### 7.3 节点

| 类型/状态 | 标签 | 视觉 |
|---|---|---|
| 入口 | `foo()` | 蓝色填充/边框 |
| 顶层函数 | `foo()` | 深灰填充、灰色边框 |
| 方法 | `MyClass.foo()` | 青色边框 |
| 嵌套函数 | `outer › inner()` | 紫色边框 |
| 未调用（显示时） | 同上 | 虚线边框、降低透明度 |
| 光标所在 | 同上 | 高亮描边 |

- 标签统一加 `()`；过长标签省略。悬停显示 `signature`、定义行范围与外部调用次数。
- 嵌套函数标签的 `outer` 使用直接父级的显示名（若父级是方法，则为 `Class.method`）。
- 节点颜色同时提供深色/浅色两套，读取 `document.body` 上的 VSCode 主题 class。

### 7.4 边

- 普通调用：灰色实线箭头。
- 环上的边与自环：琥珀色虚线箭头。
- 同对函数多次调用：合并边，标签 `×N`（N > 1）。
- 悬停边：显示 `caller → callee` 与全部调用行号。
- 点击边：跳转到 `lines[0]`。

### 7.5 布局

- dagre，`rankDir: "LR"`，`nodeSep: 40`，`rankSep: 80`，`edgeSep: 20`。
- 首次渲染与点击 `Fit` 时适应窗口；同一文件刷新时保留当前缩放与平移，拓扑变化明显时才重新 fit。MVP 简化规则：同文件刷新保留视口，切换文件或首次打开时 fit。
- 滚轮缩放、拖拽平移。
- 渲染节点超过 300 个时显示黄色提示条，但继续渲染。

### 7.6 交互

1. 点击节点：在代码所在的编辑器组中 `showTextDocument`，并把光标定位到函数定义行、居中显示。使用绑定的 `TextEditor.viewColumn`，避免把代码开到 webview 旁边。
2. 光标移动：节流 100ms，找到包含该行的最内层函数（行范围最小者），发送给 webview 高亮；不自动平移图面。
3. 光标不在任何函数内：清除高亮。
4. 刷新：打开面板、绑定文件保存（可配置）、切换到另一个 Python 文件、点击 `Refresh`。切换到的编辑器不是 Python 文件时，保留原图不变。
5. 防抖 300ms；新分析开始前终止上一次未完成的子进程，并丢弃过期结果（比较文件 mtime）。

### 7.7 状态

| 情况 | 展示 |
|---|---|
| 面板刚打开、正在分析 | 加载提示 |
| 当前文件不是 Python | 居中提示"当前文件不是 Python 文件" |
| 没有函数定义 | 居中空状态提示 |
| 语法错误 | 红色横幅：行号 + 错误信息；图区清空 |
| 找不到 Python | 横幅 + `Open Settings` 按钮，跳到 `pyCallMap.pythonPath` |
| 分析超时（5s） | 红色横幅 + stderr 末尾 20 行 |
| 非零退出/JSON 无效 | 红色横幅 + stderr 末尾 20 行 |
| 节点 > 300 | 黄色提示"图较大，可尝试隐藏未调用函数" |

### 7.8 主题与语言

- 面板 chrome 使用 `--vscode-*` CSS 变量。
- 监听 `document.body` 的 class 变化（`vscode-dark` / `vscode-light` / `vscode-high-contrast`），重新应用 Cytoscape 样式。
- 界面文案为英文；README 以中文为主，附英文简述。MVP 不做多语言 i18n。

## 8. 扩展主进程规格

### 8.1 命令与菜单

- 命令 ID：`pyCallMap.show`，标题 `PyCallMap: Show Function Call Graph`。
- 出现在命令面板，以及 Python 文件的编辑器标题栏（`menus.editor/title`，`when: editorLangId == python`）。
- 激活事件：`onCommand:pyCallMap.show`。

### 8.2 配置项

| 配置 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `pyCallMap.pythonPath` | string | `""` | 显式指定解释器；空则自动发现 |
| `pyCallMap.autoRefreshOnSave` | boolean | `true` | 保存绑定文件时自动刷新 |
| `pyCallMap.showUncalledByDefault` | boolean | `false` | 首次渲染是否显示未调用函数 |

配置变化时，若面板已打开则重新分析。

### 8.3 解释器发现顺序

1. `pyCallMap.pythonPath`（必须存在且可执行）。
2. 绑定文件所属 workspace folder 下的 `.venv/Scripts/python.exe`（Windows）或 `.venv/bin/python`（macOS/Linux）。
3. PATH 中的 `python3`（非 Windows）或 `python`；再尝试另一个。
4. 全部失败 → 报"找不到 Python"状态。

候选列表在每次分析时重新计算（开销可忽略），因此配置变化立即生效。分析时以 `-I` 启动候选解释器；若 spawn 报 `ENOENT`，尝试下一个候选。

### 8.4 子进程约束

- 使用 `child_process.spawn`，参数数组，不经过 shell。
- 工作目录设为绑定文件所在目录；分析脚本只读取传入的绝对路径，不依赖 cwd。
- 超时 5 秒；超时后 kill，并显示错误。
- stdout 上限 10 MB；超过则终止并报错。
- 扩展激活时定位 `analyze.py` 的绝对路径（`context.asAbsolutePath`）。

### 8.5 缓存

- 内存缓存：`filePath -> { mtimeMs, result }`。
- 同路径且 mtime 未变时直接复用；`Refresh` 命令忽略缓存。
- 缓存只保留最近 5 个文件，超出按最久未用淘汰。
- 分析期间文件被修改：丢弃本次结果，按新 mtime 重新分析。

### 8.6 跳转与光标同步

- 跳转使用绑定的 `TextEditor`：`showTextDocument(editor.document, { viewColumn: editor.viewColumn, selection: range })`；若编辑器已关闭，用 URI 打开到 `ViewColumn.One`。
- 监听 `onDidChangeTextEditorSelection`、`onDidChangeActiveTextEditor`、`onDidSaveTextDocument`，仅在面板存在时注册，面板 dispose 时一并释放。
- 非 Python 编辑器变为活动编辑器时，不清空图、不重新分析。

## 9. 错误处理与健壮性

- 所有用户可见错误都带下一步操作（重试/打开设置/查看输出）。
- 分析器崩溃时，把 stderr 末尾内容写入 VSCode Output Channel `PyCallMap`，面板只显示摘要。
- 文件在分析过程中被删除/重命名：显示"文件已不可用"，清空绑定。
- 工作区不受信任时，VSCode 可能禁止启动子进程：捕获错误并提示"请在受信任的工作区中使用"。
- `capabilities.untrustedWorkspaces.supported` 设为 `"limited"`。
- 扩展声明的 `engines.vscode` 为 `^1.85.0`。

## 10. 安全与隐私

- 静态分析只读取文件，不执行用户代码。
- 分析器以 `-I` 隔离模式运行，只导入标准库；文件路径通过参数传递，不拼接进代码。
- 无网络请求、无遥测、无文件写入（除 VSCode 自身的扩展存储外不需要）。
- M4 的运行时追踪会执行用户代码，必须由用户显式触发、显示确认提示，并且永不自动运行。

## 11. 测试

### 11.1 Python 分析器（核心）

使用标准库 `unittest`，fixture 文件放在 `test/python/fixtures/`。覆盖：

1. 普通顶层调用与多条边。
2. 模块级调用作为入口。
3. `if __name__ == "__main__":` 入口。
4. 找不到入口时回退 `main`。
5. 完全没有入口时 `unused` 全为 false。
6. 递归自环、互相递归、SCC 内边标记。
7. 不可达函数、只被不可达函数调用的函数。
8. 重复定义取最后一次定义并产生 warning。
9. `async def`。
10. 方法：`self.` / `cls.` / `Class.` / `super()` / 同文件继承 / `Class()` → `__init__` / 内部类无 `__init__` 不连边。
11. 嵌套函数：作用域归属、同名遮蔽、嵌套内调用外层变量不算调用。
12. 外部调用计数：内置函数、导入函数、属性调用、别名、`getattr`。
13. 调用点行号、函数 `line`/`endLine`、`signature` 生成。
14. 语法错误 → diagnostics。
15. 编码声明、UTF-8 BOM。
16. 空文件、只有 import 的文件。
17. 装饰器与默认参数中的调用被跳过。
18. 边聚合：同一对函数多次调用合并、`lines` 去重升序。

### 11.2 TypeScript 层（Vitest）

- 行号 1-based ↔ 0-based 转换。
- JSON 结构校验：缺字段、版本不符。
- `pythonBridge`：正常输出、非零退出、超时、stderr、解释器不存在（mock `child_process`）。
- 缓存命中/失效逻辑（纯函数化后测试）。
- webview 的标签生成、可见节点过滤、光标行→节点选择（纯函数）。

### 11.3 手动集成检查清单

F5 启动 Extension Development Host：

1. 打开多函数 .py，执行命令，面板出现在右侧并出图。
2. 点击节点，代码在正确编辑器组跳转并居中。
3. 点击带 `×N` 的边，跳到第一个调用点。
4. 移动光标，节点高亮跟随。
5. 保存文件，图自动刷新；重复执行命令不新建面板。
6. 打开非 Python 文件，图保持原样；对非 Python 文件执行命令，显示提示。
7. 语法错误、Python 路径错误、超时状态。
8. 切换深浅色主题。
9. 300+ 节点文件可正常渲染，显示黄色提示。
10. 在干净 VSCode 配置中安装 `.vsix` 复测 1–5。

### 11.4 CI

GitHub Actions，`ubuntu-latest` + `windows-latest`，Node 20，Python 3.10/3.11/3.12：

- `npm ci`
- `npm run typecheck`
- `npm test`
- `python -m unittest discover -s test/python -t .`
- `npm run build`
- `npx vsce package` 产出 `.vsix` artifact（不自动发布）

## 12. 工程结构与构建

```
py-call-map/
├─ package.json
├─ tsconfig.json
├─ esbuild.mjs
├─ .vscodeignore
├─ .gitignore              # 包含 .superpowers/
├─ LICENSE                 # MIT
├─ README.md
├─ CHANGELOG.md
├─ media/                  # icon.png、截图、main.js（构建产物）
├─ src/
│  ├─ extension.ts
│  ├─ controller.ts
│  ├─ pythonBridge.ts
│  ├─ protocol.ts
│  └─ webview/
│     ├─ main.ts
│     └─ styles.css
├─ python/
│  └─ analyze.py
├─ test/
│  ├─ python/
│  │  ├─ test_analyze.py
│  │  └─ fixtures/*.py
│  └─ ts/
│     └─ *.test.ts
└─ .github/workflows/ci.yml
```

构建：

- esbuild 双入口：
  - `src/extension.ts` → `dist/extension.js`（platform=node, format=cjs, external: vscode）
  - `src/webview/main.ts` → `media/main.js`（platform=browser, format=iife）
- 运行时依赖 `cytoscape`、`cytoscape-dagre`、`dagre` 全部打进 `media/main.js`，不使用 CDN。
- `npm run build`、`npm run watch`、`npm run typecheck`、`npm test`、`npm run package`。
- `package.json` 的 `main` 指向 `./dist/extension.js`。
- webview CSP：`default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-<random>'`；`localResourceRoots` 限定为扩展的 `media/`。
- `.vscodeignore` 排除 `src/`、`test/`、`docs/`、`node_modules/`、`.github/`、`.superpowers/`、构建配置；保留 `dist/`、`media/`、`python/`。

## 13. 发布

- 使用 `@vscode/vsce` 打包；先在干净的 VSCode 配置中安装 `.vsix` 验证。
- Marketplace 元数据：`displayName`、`description`、`categories`（Visualization、Programming Languages、Educational）、`keywords`、`repository`、`license: MIT`、`icon`。
- README 包含：功能截图/GIF、安装方式、使用说明、支持的语法与限制、隐私声明（本地分析、无遥测）。
- 发布到 VSCode Marketplace（个人 publisher + PAT）；可选使用 `ovsx` 同步 Open VSX。
- 版本遵循 semver，维护 CHANGELOG。
- 发布前检查扩展 ID 是否被占用；若 `py-call-map` 冲突则改名并同步更新命令命名空间。

## 14. 验收标准（MVP 完成定义）

1. 200 个函数以内的文件，从触发到出图约 1 秒内完成。
2. 点击节点准确跳到函数定义行；点击边跳到第一个调用行。
3. 光标移动高亮对应节点。
4. 保存自动刷新；重复执行命令复用面板。
5. 所有异常状态（非 Python、无函数、语法错误、找不到 Python、超时、输出无效等）均有明确提示。
6. 所有 Python 与 TS 单元测试通过，CI 在 Ubuntu 和 Windows 上全绿。
7. `.vsix` 在干净的 VSCode 配置中安装后，验收项 1–5 正常。

## 15. 风险与限制

- **名称冲突**：Marketplace 上已有多个调用图扩展，发布前需确认扩展名/显示名可用。
- **解析是启发式的**：基于名字和同文件作用域，动态调用、别名、局部变量类型推断都无法解析；README 必须明确说明。
- **Python 依赖**：要求用户机器上有可用的 Python；路径发现失败时需提供清晰的设置入口。
- **大图可读性**：300+ 节点时即使能渲染，可读性也有限；MVP 只提示，不提供自动聚合。
- **Webview 性能**：Cytoscape 对数百节点没问题；上千节点需要后续做聚合/虚拟化。
- **运行时追踪的安全边界**：M4 必须显式确认，且不在后台自动执行。

## 16. 附录：入口与环标记示例

```python
def factorial(n):
    if n <= 1:
        return 1
    return n * factorial(n - 1)   # 自环

def a():
    b()                            # a → b

def b():
    a()                            # b → a（与 a → b 构成 SCC）

def unused():
    pass                           # 无入边、不可达

def main():
    factorial(5)                   # main → factorial
    a()                            # main → a

if __name__ == "__main__":
    main()                         # main 是入口
```

期望结果：

- 节点：`factorial`、`a`、`b`、`unused`、`main`。
- 边：`main→factorial`、`main→a`、`a→b`、`b→a`、`factorial→factorial`。
- `a↔b` 与 `factorial` 自环的边 `cyclic=true`。
- `main.entry=true`；`unused.unused=true`。
- 默认视图隐藏 `unused`；打开 `Show uncalled` 后以虚线样式显示。
