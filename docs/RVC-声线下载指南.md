# RVC 公开增强包：安装与模型下载

公开增强包 **1.5.1-public1** 配合主插件 **1.9.5-test1** 使用，版本号不需要相同。它包含语音服务、依赖、RVC 推理代码，**不包含任何角色声线权重或通用模型权重**，安装脚本也不会自动下载这些模型。

基础插件的 Windows 系统语音仍可独立使用。

## 1. 安装语音运行环境

1. 先装好基础插件，确认“看一眼”和系统语音可用。
2. 从 Releases 下载并完整解压 `dsh-companion-rvc-voice-1.5.1-public1.zip`。
3. 双击解压目录的 `安装RVC语音.cmd`。安装器优先寻找已经正式安装的主插件目录，将语音文件复制到该插件的 `services/voice/`，创建 Python 虚拟环境并安装依赖。
4. 需要 Python **3.12**；DSH 自带的版本合适时会自动使用。没有合适版本时，可安装 Python 3.12，或通过 `-PythonExe` 指定解释器。
5. 安装过程中会从 PyPI / PyTorch 下载依赖，CUDA 版本可能下载数 GB；没有 NVIDIA 显卡可用 CPU。此过程不会下载模型权重。

若采用 Hot 安装或没有自动找到主插件，在 PowerShell 中明确指定它的实际目录：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<增强包目录>\安装RVC语音.ps1" -PluginDir "<主插件目录>"

# 只检查，不复制、不安装；缺少解释器、环境或模型时返回退出码 2
powershell -NoProfile -ExecutionPolicy Bypass -File "<增强包目录>\安装RVC语音.ps1" -PluginDir "<主插件目录>" -Check

# 强制安装 CPU 版
powershell -NoProfile -ExecutionPolicy Bypass -File "<增强包目录>\安装RVC语音.ps1" -PluginDir "<主插件目录>" -UseCpu
```

本仓库的 `voice-enhancement/` 只保存项目语音服务源码；完整 RVC 运行代码和预备依赖在上述增强 ZIP 中。请从增强 ZIP 执行安装。

## 2. 下载通用声学模型

这里的“主插件目录”是安装器输出的 Base plugin 路径，下面的文件都放在该目录下。

本实现使用 Transformers 格式的 HuBERT，来源为 RVC 项目维护者的 [VoiceConversionWebUI 模型仓库](https://huggingface.co/lj1995/VoiceConversionWebUI/tree/main)。

| 要下载的文件 | 来源页面 | 放到主插件目录下的路径 |
| --- | --- | --- |
| `hubert_base/pytorch_model.bin` | [HuBERT 文件目录](https://huggingface.co/lj1995/VoiceConversionWebUI/tree/main/hubert_base) | `services/voice/rvc/assets/hubert_base/pytorch_model.bin` |
| `config.json`、`preprocessor_config.json` | 同一个 HuBERT 目录；增强包已带对应小配置文件，可与权重一同更新 | `services/voice/rvc/assets/hubert_base/` |
| `rmvpe.pt` | [RMVPE 文件页](https://huggingface.co/lj1995/VoiceConversionWebUI/blob/main/rmvpe.pt) | `services/voice/rvc/assets/rmvpe/rmvpe.pt` |

下载应通过原始发布页面的下载按钮完成，避免把网页 HTML 或 Git LFS 指针当成权重文件。这里所需的是 HuBERT 的 `pytorch_model.bin`，不要仅把旧 Fairseq 格式 `hubert_base.pt` 改名。

## 3. 下载需要的角色声线

以下是本机原测试所用声线的来源入口，**本仓库与公开 ZIP 不重新分发这些文件**。请阅读原发布者的模型说明，选择合适的模型自行下载。模型名称来自发布者，不表示官方角色配音服务。

| 面板声线 / ID | 原模型发布页 | `.pth` 放置位置 |
| --- | --- | --- |
| 三月七 / `march7` | [模型发布页](https://github.com/Hanazar-Games/RVC-voice-models/releases/tag/2March_7) | `services/voice/rvc/assets/weights/march7.pth` |
| 芙宁娜 / `furina` | [模型发布页](https://github.com/Hanazar-Games/RVC-voice-models/releases/tag/5Furina) | `services/voice/rvc/assets/weights/furina.pth` |
| 纳西妲 / `nahida` | [模型发布页](https://github.com/Hanazar-Games/RVC-voice-models/releases/tag/9Nahida) | `services/voice/rvc/assets/weights/nahida.pth` |
| 雷电将军 / `shogun` | [模型发布页](https://github.com/Hanazar-Games/RVC-voice-models/releases/tag/10Shogun) | `services/voice/rvc/assets/weights/shogun.pth` |

下载到的推理 `.pth` 若名称不同，按所选 ID 重命名；若有配套 `.index`，放到 `services/voice/rvc/assets/indices/<同一ID>.index`。只下自己要用的声线即可。不要把训练检查点、检索索引或其它变声框架的模型当作 RVC 推理 `.pth`。

## 4. 启用与核对

1. 下载并放好 HuBERT、RMVPE，以及至少一个声线 `.pth`。
2. 回到陪玩设置，语音后端选“自动”或“语音服务”，声线选已下载的那个 ID。插件初始声线为 `shogun`；如果只下了三月七，请改为 `march7`。
3. 点击“重启语音”，或完整重启 DSH。首次加载模型可能较慢。
4. 点“看一眼”试听。依赖安装成功不等于模型已放好；只有实际发出目标声线后，才算增强功能验收完成。

服务日志在 DSH 数据目录的 `dsh-companion/services/voice.log`。缺少 `pytorch_model.bin`、`rmvpe.pt` 或对应 `.pth` 时，按报错路径核对文件。公开包在未补模型时不会承诺 RVC 可用，可继续使用基础系统语音。

## 公开包验证范围

已检查公开 ZIP 不含 `.pth`、`.index`、`.pt`、`.bin`、`.onnx`、`.safetensors`、`.ckpt` 等模型文件，并保留运行代码与相关许可证。未在新电脑上执行依赖下载、GPU 推理或试听；请按上述流程做实际安装验证。
