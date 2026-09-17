# pi-experiencev2

Pi 的 Run 归档插件：自动记录执行、后台生成摘要，让 AI 按需查找历史、展开原始消息，并在用户授权后删除指定 Run。

需要 Node.js 24+ 和 Pi 0.85.1+。旧归档保持独立。

## 开始使用

```bash
pi install npm:pi-experiencev2
```

重新启动 Pi，在 Pi 中输入 `/runs` 即可查阅。

本地开发安装：`npm ci --ignore-scripts && npm run build && pi install .`；修改源码后重新构建并 `/reload`。

如需独立试用，在已安装开发依赖的仓库目录执行：

```bash
pi --no-extensions -e ./src/index.ts
```

这次启动只加载 v2 扩展，不修改安装配置。正常对话即自动积累 Run；输入 `/runs` 查看当前目录的历史，选记录后逐层打开消息。默认库为 Pi agent 目录下的 `run-archive/runs.sqlite`（通常是 `~/.pi/agent/run-archive/runs.sqlite`），首次从空库开始，之后持续保留。

试验库可通过 `--runs-db <路径>` 或 `PI_RUNS_DB` 指定，前者优先；`--runs-no-summary` 可关闭后台模型摘要。修改库路径或摘要开关后，重新启动 Pi。归档包含原始消息与工具数据，请按敏感资料保护。

## 查阅入口

| 使用者 | 入口 |
| --- | --- |
| 用户 | `/runs` 浏览，`/runs search <关键词>` 搜索，`/runs all` 查看全库 |
| AI | `find_run` 搜索或按 Run ID 读取消息预览 |
| AI | `get_message_detail` 展开消息，长内容无损续页 |
| AI | `delete_run` 在用户明确授权范围内批量删除，活动 Run 受保护 |

摘要使用本轮结束时选中的模型及现有认证，在后台读取本轮归档证据生成。摘要失败不影响原文，可用 `/runs summary r1` 重试；诊断入口为 `/runs debug`。记录中的 ID 以查询实际返回为准。

## 产品边界

- Run 是唯一的经历实体；只积累启用后的执行，旧库保持原样。
- 模型入口限于三个工具及其结果。当前对话的上下文管理交给 Pi；v2 不注入历史目录、不折叠消息、不要求维护笔记。
- 删除作用于插件归档，保留最小墓碑和原因；Pi 自身会话文件仍由宿主管理。
- 有记录就能查阅；执行结果由摘要和原文说明，不给 Run 分类为成功、失败或中止。内部仅保留录制中保护，已保存不代表任务成功。

## 进一步阅读

- [命令、工具与运行边界](docs/usage.md)
- [结构与职责](docs/design.md)，含 pi-note 的独立分工
- [验证结果与尚未验证的部分](docs/verification.md)
- [设计演进](README-Evolution.md)
- [npm 发布与 OIDC 配置](docs/publishing.md)

开发检查：`npm run check`。真实模型实验和规模基准的入口见验证记录；均使用隔离库。
