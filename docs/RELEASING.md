# 发布 Windows 便携版

项目通过 GitHub Actions 发布 Windows x64 免安装便携版。正式版本使用 `v1.2.3` 格式的 Git 标签，Release 产物命名为：

```text
GokuGoku-v1.2.3-Windows-x64.zip
```

ZIP 内包含完整的便携目录。`GokuGoku.exe` 依赖同目录中的 DLL、资源包和 `resources` 文件夹，因此不单独发布裸 EXE。

## 发布后续版本

根据变更范围选择一种版本升级：

```powershell
git switch main
git pull --ff-only
npm ci
npm test
npm version patch
git push origin main --follow-tags
```

- `npm version patch`：修复版本，例如 `1.1.0 → 1.1.1`
- `npm version minor`：向后兼容的新功能，例如 `1.1.0 → 1.2.0`
- `npm version major`：不兼容更新，例如 `1.1.0 → 2.0.0`

`npm version` 会同时更新 `package.json`、`package-lock.json`，创建版本提交和对应的 `v` 前缀标签。Release 工作流会拒绝以下情况：

- 标签不是完整的稳定版本号；
- 标签版本与 `package.json.version` 不一致；
- 标签对应的提交不在 `main` 历史中；
- 测试、Windows 打包或 EXE 版本检查失败；
- 便携 ZIP 超过 160 MiB。

不要移动、复用或强制覆盖已经发布的标签。普通 `main` 提交和 Pull Request 只运行 CI，不会创建 Release。

## 签名提示

当前便携版没有商业代码签名，Windows 可能显示安全提醒。请只从项目的 GitHub Releases 页面下载。
