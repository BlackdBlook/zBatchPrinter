# BatchPrint — 本地 PDF 批量打印

双击 `start.bat` 即可启动本地服务并自动打开网页，选择多个本地 PDF 文件，
统一设置打印排版（方向、页边距、缩放、纸张、对齐、份数、双面、黑白等）后，一键批量静默打印 ——
不会为每个文件弹出打印对话框。

本仓库完全由GLM-5.3编写~~除了这句话~~

## 使用方法

1. 双击 `start.bat`（首次运行会自动安装依赖、自动下载便携版 SumatraPDF 打印引擎，需联网）。
2. 浏览器自动打开 `http://localhost:8163`。
3. 点击或拖入多个 PDF 文件；也可以直接拖入**文件夹**（含子文件夹），会自动递归找出其中的所有 PDF 一并加入列表。
4. 在右侧设置打印参数；**单击左侧文件列表中的任意文件**可切换预览到该文件（再次修改设置会自动刷新），也可点「生成预览」查看当前选中文件。
5. 点击「开始批量打印」，列表实时显示每个文件的进度；可随时取消。

关闭命令行窗口即停止服务；临时文件在下次启动时自动清理。

## 环境要求

- Windows 10/11，已安装 [Node.js](https://nodejs.org/)（LTS）
- 至少一台已安装驱动的打印机
- 打印引擎：SumatraPDF（服务会自动下载便携版到 `tools\SumatraPDF\`，
  也可以自己放入该目录或提前安装，二选一）

## 工作原理

- 浏览器把所选 PDF 上传给本地服务（`127.0.0.1`，不经外网）；拖入文件夹时由网页端递归遍历目录（受浏览器安全模型限制，网页拿不到文件夹的真实路径，因此逐个读取文件内容后上传，列表中以相对路径显示来源）。
- 服务端用 [pdf-lib](https://github.com/Hopding/pdf-lib) 按设置把每个 PDF **重新排版**成
  「精确等于目标纸张尺寸」的新 PDF：选纸张 → 定方向（自动/纵向/横向，强制方向时内容旋转 90°）
  → 按页边距计算可用区域 → 按缩放模式（适应页面 / 实际大小 / 自定义百分比）缩放 → 按对齐方式放置。
- 再用 SumatraPDF 命令行（`-print-to ... -silent -noscale -paper=auto`）静默发送到指定打印机，
  原生支持份数（`3x`）、双面（长边/短边）、彩色/黑白。
- 打印任务在服务端排队顺序执行，网页轮询显示每个文件的状态。

## 目录结构

```
BatchPrint/
├─ start.bat        # 双击运行入口
├─ server.js        # 本地服务（零框架）
├─ public/          # 网页（index.html / app.js / style.css）
├─ tools/           # SumatraPDF 便携版（自动下载）
└─ temp/            # 上传与排版缓存（启动时自动清理）
```

## 仓库不含的内容（克隆后需自行补充）

出于体积、隐私和第三方版权考虑，以下内容**不进入仓库**，获取源码后按下表补充：

| 内容 | 补充方式 |
| --- | --- |
| `node_modules/` | 运行 `npm install`（双击 `start.bat` 会自动执行） |
| `tools/SumatraPDF/` | 首次启动服务时自动从官网下载便携版；也可手动放置或提前安装（见上文环境要求） |
| `temp/` | 无需补充，服务启动时自动创建并在下次启动时清理 |
| `tests/samples/` | 运行 `node tests/make-samples.mjs` 生成测试样本 PDF |
| `tests/testpage.pdf` | 真实打印链路测试（`verify-real-print.mjs`、`print-test.mjs`）使用的测试页，自备任意一张 PDF 改名放入即可 |
| `tests/out/`、`tests/queue-observations.txt` | 测试产物，运行测试时自动生成，无需补充 |

## 开发与测试

```bash
npm install
node tests/make-samples.mjs        # 生成 tests/samples/ 样本
node tests/verify-traverse.mjs     # 拖入文件夹的递归遍历逻辑（无需启动服务）
node tests/dom-smoke.mjs           # 前端初始化冒烟测试（无需启动服务）

# 以干跑模式启动服务（只打印命令、不真打印，不自动开浏览器）
BATCHPRINT_DRY=1 BATCHPRINT_NO_OPEN=1 node server.js
node tests/verify-transforms.mjs   # 排版变换断言 + PNG 渲染（另开终端，需服务已启动）
node tests/verify-print-job.mjs    # 批量任务流程断言（需服务以 DRY 模式启动）

# 真实打印链路验证（会向指定打印机真实发送一张 tests/testpage.pdf）
node tests/verify-real-print.mjs <打印机名>
```

> Windows PowerShell 下设置环境变量的写法：`$env:BATCHPRINT_DRY=1; $env:BATCHPRINT_NO_OPEN=1; node server.js`。

## 许可与第三方组件

- 本项目自身代码以 [MIT 许可](LICENSE)发布。
- 打印引擎 [SumatraPDF](https://www.sumatrapdfreader.org/) 为 **GPLv3** 第三方软件：仓库**不附带**其可执行文件，仅在使用时从官网自动下载或由用户自行安装，与本工具独立分发。
- PDF 排版依赖 [pdf-lib](https://github.com/Hopding/pdf-lib)（MIT）。

## 常见问题

- **打印引擎下载失败**：手动到 [sumatrapdfreader.org](https://www.sumatrapdfreader.org/download-free-pdf-viewer)
  下载便携版，把解压出的 `SumatraPDF.exe` 放进 `tools\SumatraPDF\` 文件夹后重启服务。
- **方向设置的含义**：「纵向 / 横向」只决定纸张的横竖，**内容始终保持正向**（不旋转）。例如纵向内容放到横向纸上会缩小居中、两侧留白。若选择「自动」，则每页按自身内容方向匹配纸张。
- **页边距与对齐的关系**：对齐（居中/靠左/靠上等）的基准是"页边距框"——纸张减去四边页边距后的区域，因此不对称的页边距（如上 20mm、下 10mm）会直接体现为不对称的留白。「适应页面」缩放也以页边距框为界。
- **预览里出现来源不明的页眉/URL**：部分 PDF（如电子发票）是在整块 A4 画布上生成、再用裁剪框只露出发票区域的，画布上看不见的位置可能残留模板内容。本工具按查看器实际显示的裁剪区域（CropBox）重排，这类残留不会进入预览和打印。
- **加密 PDF**：带密码的 PDF 无法处理，请先解密。
- **页边距为 0 时内容被裁掉一点**：打印机存在物理不可打印区域，属正常现象，可适当加大页边距。
- **端口被占用**：服务会自动尝试后续端口（8164–8172），以命令行窗口打印的地址为准。
