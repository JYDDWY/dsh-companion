# 第三方组件与致谢

本项目代码以 MIT 许可发布，完整文本见 [LICENSE](LICENSE)。参考或改编的工作如下：

| 组件 | 来源 | 许可 | 用途 |
| --- | --- | --- | --- |
| `win/helper-win.ps1` 截图兜底 | [dsh-game-pet（bigk5780/dsh）](https://github.com/bigk5780/dsh) | MIT | 基于其实现增加连拍、JPEG 缩放和键鼠空闲检测 |
| 两步提示词思路 | 同上 | MIT | 识图抽取信息，再结合人格生成台词 |
| 宿主与浏览器插件写法 | [dsh-pet（PC2005-cloud/dsh-pet）](https://github.com/PC2005-cloud/dsh-pet) | MIT | 参考插件结构、配置与路由组织 |
| 右侧栏扩展 API 用法 | [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) | MIT | 参考右侧栏扩展方式 |

运行时使用 Windows SAPI，以及 DSH 提供的模型、网页、附件和 WebServer 能力。

RVC、edge-tts 和声线模型属于可选语音增强链路。项目语音服务源码位于 `voice-enhancement/`；独立公开 runtime 包包含 RVC 推理代码与依赖并保留许可证，不包含任何模型权重。RVC 上游来源为 https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI 。
