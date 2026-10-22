# 安装、更新与卸载

## 安装前

1. 在 Windows 上安装并启动一次 DSH，让它创建用户 profile。
2. 确认 DSH 的模型配置可以正常使用，并准备一个支持图片输入的模型。
3. 将插件放到准备长期保留的目录。该目录中应能看到 `package.json`、`安装.cmd` 和 `install.ps1`。

基础插件可用 PowerShell 截图和 Windows 系统语音，不要求另装 Python 或 RVC。

## 推荐安装方式

双击插件目录里的 `安装.cmd`。也可在 PowerShell 中运行（替换为自己的真实路径）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<插件目录>\install.ps1"
```

脚本默认寻找 `%USERPROFILE%\.dsh` 或 `DSH_HOME`，并优先使用已初始化的 desktop profile。它会备份配置、登记 bundle、添加 link 依赖，并创建目录链接。不会执行 pnpm install。

安装后重启 DSH，在插件列表和右侧边栏里检查“陪玩”，再点“看一眼”验证。插件安装后仍使用原来的目录，不能随意移动或删除。

## 其他安装参数

```powershell
# 指定 web profile
powershell -NoProfile -ExecutionPolicy Bypass -File "<插件目录>\install.ps1" -ProfileName web

# 指定自己的 DSH 数据目录
powershell -NoProfile -ExecutionPolicy Bypass -File "<插件目录>\install.ps1" -DshHome "<DSH数据目录>"

# file 路径方式安装：宿主可热加载，面板需刷新；不出现在已安装插件列表
powershell -NoProfile -ExecutionPolicy Bypass -File "<插件目录>\install.ps1" -Hot
```

正式 bundle 与 file 路径方式不应重复挂载同一插件。首次使用建议采用默认方式，按安装器输出操作。

## 更新

保留原来的插件目录位置，用新版本文件更新，再重新执行安装器并重启 DSH。如果改用新目录，应重新运行该新目录中的安装器以更新链接。

用户配置、历史和世界书保存在 DSH 数据目录的 `dsh-companion/` 中。

## 卸载

双击插件目录中的 `卸载.cmd`，或运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<插件目录>\install.ps1" -Uninstall
```

完成后重启 DSH。卸载器移除安装登记与目录链接，用户数据保留在 DSH 数据目录。

## 排查安装问题

- 找不到 profile：确认已启动过 DSH，或用参数指定数据目录与 profile。
- 找不到安装器：确认压缩包已经完整解压，当前目录中有 `install.ps1`。
- 面板没有出现：重启 DSH，并在插件列表检查状态。
- 没有声音：检查朗读开关，基础包可选择“系统语音”后端。
- 模型报错：在插件设置中确认识图模型支持图片、服务商配置可用。
- 日志：默认在 `%USERPROFILE%\.dsh\dsh-companion\companion.log`。

截图会发给配置的模型服务商；当前测试版的已知问题见 [README.md](README.md)。
