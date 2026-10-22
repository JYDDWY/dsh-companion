# RVC 语音增强：安装与模型下载

主插件 **1.9.6-test4** 新增国内源一键环境安装。可选运行组件为 `@jyddwy/dsh-companion-rvc-runtime@1.5.3-public1`，与主插件独立编号。

**不分发、不自动下载任何角色声线、HuBERT 或 RMVPE 模型权重。** Windows 系统语音可独立使用。

## 1. 一键安装运行环境

1. 通过 DSH「添加插件」安装 `@jyddwy/dsh-companion@1.9.6-test4`，国内用户选择「中国大陆镜像源」。
2. 打开「陪玩 → 设置 → 声音」，点击「下载并安装语音增强（CPU）」。
3. 等待面板提示环境安装完成。无需手动安装 Python、运行命令行或访问 GitHub。下载数百 MB，请预留约 3 GB 磁盘空间。
4. 点击「打开模型目录」，按下文下载模型。下载模型的网站不在一键安装的覆盖范围内，可达性由网络决定。

运行环境位于 DSH 用户数据目录的 `dsh-companion/voice/runtimes/`，模型独立放在 `voice/models/`。更新主插件会保留两者。CPU 版不要求 NVIDIA 显卡，但速度取决于硬件。

此前通过 ZIP 安装的环境仍按旧目录工作；明确配置的 Python/服务脚本优先。使用新入口后，请将已有模型自行复制到面板显示的新模型目录。

## 2. 下载通用声学模型

先点击设置里的「打开模型目录」。以下所有路径均相对此目录，不是 npm 插件目录。默认位置为 `%USERPROFILE%\.dsh\dsh-companion\voice\models\`；设置 `DSH_HOME` 时以面板显示为准。

本实现使用 Transformers 格式的 HuBERT，来源为 RVC 项目维护者的 [VoiceConversionWebUI 模型仓库](https://huggingface.co/lj1995/VoiceConversionWebUI/tree/main)。

| 要下载的文件 | 来源页面 | 放到模型目录下的路径 |
| --- | --- | --- |
| `hubert_base/pytorch_model.bin` | [HuBERT 文件目录](https://huggingface.co/lj1995/VoiceConversionWebUI/tree/main/hubert_base) | `hubert_base/pytorch_model.bin` |
| `config.json`、`preprocessor_config.json` | 同一个 HuBERT 目录；安装器已带对应小配置文件，可与权重一同更新 | `hubert_base/` |
| `rmvpe.pt` | [RMVPE 文件页](https://huggingface.co/lj1995/VoiceConversionWebUI/blob/main/rmvpe.pt) | `rmvpe/rmvpe.pt` |

下载应通过原始发布页面的下载按钮完成，避免把网页 HTML 或 Git LFS 指针当成权重文件。这里所需的是 HuBERT 的 `pytorch_model.bin`，不要仅把旧 Fairseq 格式 `hubert_base.pt` 改名。

## 3. 下载需要的角色声线

以下是本机原测试所用声线的来源入口，**本仓库与公开 ZIP 不重新分发这些文件**。请阅读原发布者的模型说明，选择合适的模型自行下载。模型名称来自发布者，不表示官方角色配音服务。

| 面板声线 / ID | 原模型发布页 | `.pth` 放置位置 |
| --- | --- | --- |
| 三月七 / `march7` | [模型发布页](https://github.com/Hanazar-Games/RVC-voice-models/releases/tag/2March_7) | `weights/march7.pth` |
| 芙宁娜 / `furina` | [模型发布页](https://github.com/Hanazar-Games/RVC-voice-models/releases/tag/5Furina) | `weights/furina.pth` |
| 纳西妲 / `nahida` | [模型发布页](https://github.com/Hanazar-Games/RVC-voice-models/releases/tag/9Nahida) | `weights/nahida.pth` |
| 雷电将军 / `shogun` | [模型发布页](https://github.com/Hanazar-Games/RVC-voice-models/releases/tag/10Shogun) | `weights/shogun.pth` |

下载到的推理 `.pth` 若名称不同，按所选 ID 重命名；若有配套 `.index`，放到 `indices/<同一ID>.index`。只下自己要用的声线即可。不要把训练检查点、检索索引或其它变声框架的模型当作 RVC 推理 `.pth`。

## 4. 启用与核对

1. 下载并放好 HuBERT、RMVPE，以及至少一个声线 `.pth`。
2. 回到陪玩设置，语音后端选“自动”或“语音服务”，声线选已下载的那个 ID。插件初始声线为 `shogun`；如果只下了三月七，请改为 `march7`。
3. 点击“重启语音”，或完整重启 DSH。首次加载模型可能较慢。
4. 点“看一眼”试听。依赖安装成功不等于模型已放好；只有实际发出目标声线后，才算增强功能验收完成。

服务日志在 DSH 数据目录的 `dsh-companion/services/voice.log`。缺少 `pytorch_model.bin`、`rmvpe.pt` 或对应 `.pth` 时，按报错路径核对文件。公开包在未补模型时不会承诺 RVC 可用，可继续使用基础系统语音。

