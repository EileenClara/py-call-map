# PyCallMap

把 Python 文件或 Jupyter notebook 里的函数调用关系画成一张横向调用图，点击节点即可跳到对应代码。

PyCallMap visualizes the function call graph of a single Python file or notebook as an
interactive left-to-right diagram. Click a node to jump to its definition.

![PyCallMap screenshot](media/screenshot.png)

## 功能

- 横向有向调用图，每个函数只出现一次
- 支持 Jupyter notebook：所有代码单元格合成一张调用图
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

需要 Python 3.9 或更高版本（分析脚本使用了内置泛型），CI 在 Python 3.10–3.12 上测试。

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

1. 打开一个 `.py` 文件或 `.ipynb` notebook。
2. 执行命令 `PyCallMap`，或点击编辑器 / notebook 工具栏的图图标。
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
- 被跳过的装饰器、默认值、注解调用不计入；只有无法解析（unresolvable）的调用会计入所在函数的「外部调用」数量
- Notebook 按文档顺序分析，忽略 `execution_count`
- 以 `%%` 开头的 cell 会被整体跳过；`%`、`!`、`?` 魔术命令行按 `pass` 处理，因此其中的代码不会被分析
- Notebook 只分析 code cell，忽略 markdown 和输出

## 设置

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `pyCallMap.pythonPath` | `""` | 指定 Python 解释器；留空时自动查找 `.venv` 和 PATH |
| `pyCallMap.autoRefreshOnSave` | `true` | 保存绑定的 Python 文件时自动刷新 |
| `pyCallMap.showUncalledByDefault` | `false` | 首次打开时显示不可达函数 |

## 隐私

PyCallMap 只读取当前 Python 文件或 notebook 的 code cell，并把 notebook 单元格临时拼接成本地 `.py` 文件交给标准库分析脚本；该临时文件在分析结束后立即删除。它不发送任何数据，不包含遥测，也不执行用户代码。

## 开发

```bash
npm run typecheck
npm test
python -m unittest discover -s test/python -p "test_*.py" -v
npm run build
npm run package
```

## English summary

PyCallMap renders a single Python file's or notebook's function call graph as an interactive
left-to-right diagram. It supports top-level functions, methods, nested
functions, recursion, entry detection, click-to-code navigation, and cursor
highlighting. Notebook cells are concatenated in document order into a temporary local file; no cell code is executed. Analysis runs locally with Python's standard library; no code is
executed and no data leaves the machine.

## License

MIT
