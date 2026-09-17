# npm 发布

## 发布流程

`main` 与 PR 会在 Node.js 24、26 上执行 CI。发布入口是 `v<package.json 版本>` tag；`release.yml` 校验版本、运行检查、构建 npm 包并在临时目录安装测试，然后通过 npm OIDC 发布，最后生成带 tarball 和 SHA-256 校验文件的 GitHub Release。

包入口为 `dist/index.js`。npm 包只包含运行文件和使用文档，不包含本地配置、数据库、测试或开发依赖。`pi-context-trace` 的包验证额外启动查看器并读取 HTML、CSS、JavaScript，检查跨源访问被拒绝。

## 首次配置

首次发布需要维护者 npm 登录；包创建后，在 npm 包的 Settings → Trusted publishing 中添加 GitHub Actions：

- Organization or user：`liu-zhengdong`
- Repository：当前 GitHub 仓库名（不含 npm scope）
- Workflow filename：`release.yml`
- Environment：留空（工作流未使用 GitHub Environment）

首次发布命令（在仓库根目录执行）：

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run test:package
npm login
npm publish ./release/*.tgz --access public
```

首次手工发布不带 GitHub provenance。Trusted publisher 生效后，新版本由 Actions 生成 provenance；无需存放长期 `NPM_TOKEN` secret。若账号要求二步认证，按 npm 提示在浏览器完成。

## 后续版本

在发布分支更新版本、提交 PR，通过 CI 并合入后，从最新 `main` 推送 tag：

```bash
npm version patch --no-git-tag-version
# 提交 package.json / package-lock.json，创建并合入 PR 后：
git switch main
git pull --ff-only
version="$(node -p "require('./package.json').version")"
node scripts/check-tag.mjs "v$version"
git tag "v$version"
git push origin "v$version"
```

`npm run test:package` 会先构建，再生成 `release/*.tgz`，从 tarball 安装到临时目录，通过原生 ESM 与 Pi ResourceLoader 验证加载。不会使用个人 Pi 配置或调用模型。包清单含非白名单文件、插件加载失败或查看器资源缺失都会中止。

包验证脚本兼容 npm 11 的数组型与 npm 12 的对象型 `npm pack --json` 输出；升级 npm 后，以实际打包和隔离安装结果检查兼容性。

发布工作流只接受与 package.json 完全一致的 tag。同一版本重跑时，只有 npm 已有 tarball 的 SHA-1 与本次构建一致才跳过发布；不一致则失败，不覆盖既有版本。
