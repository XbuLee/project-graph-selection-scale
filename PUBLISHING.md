# GitHub 发布与扩展市场收录

依据作者的[扩展市场文档](https://graphif.dev/docs/extension/distribution/marketplace)整理，核对日期：2026-11-12。

## 直接分享

把 `dist/选区等比缩放-v1.0.0-分享包.zip` 发给使用者即可。包内包括插件安装包、原始示例图、使用说明、完整 README 和许可证。对方解压后，用 Project Graph 打开 `local.selection-scale.prg` 并安装。

也可以只发送 `dist/local.selection-scale.prg`。不要把示例图当作插件安装包发送。

## 发布到 GitHub

公开仓库：[XbuLee/project-graph-selection-scale](https://github.com/XbuLee/project-graph-selection-scale)，作者：`XbuLee`。以下保留首次建仓步骤；现有仓库发布后续版本时，更新版本、提交文件并推送相应标签即可。

1. 解压 `dist/selection-scale-v1.0.0-source.zip`，将**解压出的内容**放到独立仓库根目录，包含隐藏的 `.github/` 和 `.gitignore`。不要上传整个 Project Graph 工程，不要再套一层 selection-scale 目录。
2. 安装 Node.js 22 或更高版本，执行 `npm ci`、`npm run check`、`npm test`、`npm run package`。
3. 提交所有源码及根目录 `metadata.msgpack`。`dist/` 和 `node_modules/` 已排除，不需要提交。主工程的集成测试在原 Project Graph 仓库中，独立源码包可运行的是插件的 29 项测试。
4. 在 GitHub 创建 Public 仓库，在仓库 About / Topics 中添加 **`extprg`**。
5. 推送 `main` 或 `master` 分支，再创建并推送与 `package.json` 版本一致的标签，例如 `v1.0.0`。
6. GitHub Actions 会检查、打包，再创建 Release，附上 `local.selection-scale.prg`、分享 ZIP 和源码 ZIP。

推送默认分支后，可在独立仓库执行：

```sh
git tag v1.0.0
git push origin v1.0.0
```

`main` 分支推送只运行检查，`release` 作业会显示 skipped。必须推送 `v*` 标签才会发布；重新运行分支工作流仍然会跳过发布。已存在的版本标签不要重复创建或强制覆盖。

如果不使用 GitHub Actions，也可手动创建同版本的 Release，上传 `.prg` 安装包与分享 ZIP。后续更新版本时，修改 `package.json` 和 `CHANGELOG.md`，重新打包并提交生成的 `metadata.json`、`metadata.msgpack`，再推送新版本标签。扩展 ID 保持 `local.selection-scale`，避免已安装用户出现两个扩展。

## 扩展市场收录条件

- 仓库开源且为 Public。
- GitHub 仓库 Topic 包含 `extprg`；`package.json` 的 keywords 不能替代 Topic。
- 默认分支根目录有合规的 `metadata.msgpack`，或由 `create-extprg` 生成的 `package.json`。本插件采用前一种直接开发格式。
- 至少一个公开 Release，附件包含 `.prg` 文件。

官方说明服务器会定期扫描，至少等待 5 分钟。符合文件条件不等于已经确认收录，以市场实际显示为准。

## 当前状态

公开仓库已建立并添加 `extprg` Topic，应用内和工作流验证记录见 `VALIDATION.md`。版本与附件以 [GitHub Releases](https://github.com/XbuLee/project-graph-selection-scale/releases) 为准，扩展市场是否已收录仍需以市场实际显示为准。
