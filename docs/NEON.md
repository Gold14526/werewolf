# 使用自己的 GitHub Pages + Neon 部署

GitHub 仓库保存源码，GitHub Pages 托管网页；浏览器把匹配、房间、聊天和行动请求发给 Neon Function，Function 在 Postgres 中读取并提交对局状态。Neon 后端只需要一个项目，前端继续使用自己的 Pages 网址。本说明是部署步骤，不表示接口已经发布或完成线上验证。

## 准备与构建

1. 在自己的 Neon 账号创建项目，选择支持 Functions 的区域；中国及周边玩家可先选择 Singapore。保留同一个生产分支和数据库，重新发布函数不需要重新创建项目。
2. 本地安装 Node.js 22.13 或更新版本；Neon Functions 的运行环境为 Node.js 24。
3. 在仓库根目录安装依赖并构建：

```bash
npm ci
npm run build:neon
```

产物是 `dist-neon/index.mjs` 和 `dist-neon/werewolf.zip`；ZIP 根目录只有 `index.mjs`。构建会打包后端代码和所需依赖，不包含前端网页、数据库内容或连接凭据。静态网页仍由 `npm run build` 生成到 `dist/`，两种构建互不覆盖。

## 发布联机 API

按 [Neon Functions 快速开始](https://neon.com/docs/compute/functions/get-started) 登录 Neon CLI，并使用 `neon link` 关联目标项目和生产分支。CLI 可能打开浏览器授权；务必确认选中自己的项目。连接信息和 CLI 凭据只保存在本机或平台中，不提交到 GitHub。

```bash
npx neon@latest link
```

仓库的 `neon.ts` 指向 `neon/index.mjs`。完成关联后，可在仓库根目录发布：

```bash
npx neon@latest deploy
```

CLI 会自行打包配置中的源码；它不依赖上一步生成的 ZIP。也可使用已构建的单文件：

```bash
npx neon@latest functions deploy werewolf --src dist-neon/index.mjs --no-bundle
```

这两种方式选择其一。部署已有后端时，保持相同项目、分支和函数名。ZIP 是构建产物，不需要将它提交为 GitHub Pages 网站文件。

后端使用以下环境变量：

| 变量 | 设置方式 |
| --- | --- |
| `DATABASE_URL` | Neon 为 Function 注入所在分支的数据库连接。它是私密凭据，不可放入前端配置、Pages 变量或源码。 |
| `ALLOWED_ORIGINS` | 允许调用 API 的网页来源，多个值用逗号分隔。当前 `neon.ts` 配置为 `https://gold14526.github.io`；复制仓库或使用自定义域名时，修改 `functions.werewolf.env.ALLOWED_ORIGINS` 后再发布。 |

例如页面为 `https://alice.github.io/werewolf/`，来源应填 `https://alice.github.io`，不包含路径；自定义域名页面可填写 `https://play.example.com`。设置环境变量的方法见 [Neon Functions 环境变量](https://neon.com/docs/compute/functions/environment-variables)。

Function 首次连接会在事务中初始化 `moonwolf_pg_meta` 和 `moonwolf_pg_entities` 两张表，结构见 `neon/schema.sql`；普通重新部署不会清空或重建已有数据。Cloudflare 的 `drizzle/` 迁移用于另一套 D1 后端，不应用到 Neon Postgres。

发布成功后，记录 CLI 返回的 Function HTTPS 根地址。访问其 `/api/health`，应得到包含以下字段的 JSON：

```json
{"ok":true,"service":"moonwolf","storage":"postgres","version":2}
```

根路径返回 404 是正常的：这个地址只提供 `/api/` 接口，网页由 GitHub Pages 提供。健康检查成功说明数据库可连接，仍需完成下面的浏览器联机验证。

## 接到 GitHub Pages

1. 在自己的 GitHub 仓库 **Settings → Secrets and variables → Actions → Variables** 设置 `API_BASE_URL`，值为 Function 的 HTTPS 根地址，不要加 `/api`。
2. 在 **Settings → Pages** 选择 **GitHub Actions** 作为发布来源。
3. 运行 **Deploy GitHub Pages** 工作流，或向 `main` 提交修改触发发布。
4. 从 Pages 网址进入游戏。若浏览器之前手动配置过其他后端，在「联机设置」更新或清除旧值。

`API_BASE_URL` 是公开地址，不是数据库连接串。所有玩家必须连接同一 Function 和同一生产数据库，才能共享匹配队列与房间。具体 Pages 发布步骤也见 [README](../README.md#部署到-github-pages)。

## 数据保存与恢复

每次业务请求都会连接 Postgres，在事务中锁定同一条元数据记录，然后读取状态、校验操作、写入变化并提交。只有提交成功后才返回成功响应。多函数实例使用同一数据库锁协调；不把进程内存当作房间的最终状态。数据库连接或写入失败时返回 503，不退回临时内存模式。异常或不完整的数据会阻止处理，代码不会悄悄清空数据库后重新开始。

房间、玩家会话、随机身份、已经提交的技能与投票、聊天、结束记录和战绩均在数据库中。Function 被回收或代码重新发布后，再次请求从同一数据库读取这些状态。数据库里保存会话令牌的摘要；玩家仍须保留原浏览器标签页的 `sessionStorage` 才能恢复身份，不能只凭昵称找回座位。

计时恢复按**全站业务活动**判断，不按某一个实例是否启动判断：

- 普通冷启动或部署替换，若没有超过 60 秒的业务活动间隔，不延长正在进行的阶段。
- 距最后保存的业务活动记录超过 60 秒时，下一次业务请求把整个间隔视为暂停，并平移会话、房间的活动时间。进行中的阶段恢复剩余时间，且至少留 30 秒操作时间。
- 恢复时房间与会话获得 2 分钟重连宽限。数据库锁保证同一段中断只恢复一次，不会因多个新实例启动而反复延长。
- `/api/health` 不更新业务活动记录，也不推进对局。游戏阶段由业务请求推进，没有必须持续运行的内存定时器。
- 只要全站仍有业务请求，其他房间或离线玩家的正常清理计时就继续运行。一个玩家关掉页面不等于暂停整局。

正常运行与恢复宽限结束后，等待玩家超过 2 分钟无活动会被移出房间；房间整体闲置超过 30 分钟会清理；会话闲置超过 24 小时失效。已按规则删除的数据不会因重启重新出现。这些应用规则与 Neon 的数据库休眠机制是两回事。

当前应用自身的容量边界：

| 项目 | 上限或处理方式 |
| --- | --- |
| 活动房间 / 会话 | 20 / 500。 |
| 结束记录 | 至多最近 20 场；房间与历史数据合计超过约 8 MiB 时，进一步删除旧记录。 |
| 每房间聊天 | 最近 400 条；房间记录超过约 220 KiB 时进一步裁剪旧消息。 |
| 战绩 | 至多 2000 名玩家，超出后清理最旧记录。 |
| 存储校验 | 全部业务状态至多 10 MiB、单实体至多 1 MiB，超出时拒绝本次操作。 |

这些限制用于小规模组局，不等于 Neon 提供的数据库容量。当前事务会串行处理全站状态；扩大公开运营规模前，应重新评估状态分区与并发设计。

## 免费计划与备份

以 [Neon 当前计划说明](https://neon.com/docs/introduction/plans) 为准：Free 包含每项目 1 GB Postgres 存储、每月 100 CU-hours、100 万次 Functions 调用、10 active / 400 waiting Capacity-Hours，以及项目内各服务共享的 5 GB 公网流量。免费数据库空闲 5 分钟会休眠，访问后自动唤醒；超过算力或流量额度可能暂停服务至下一周期。额度限制不会删除数据，但它们会影响当月能否继续联机。

轮询会消耗调用次数与流量，打开页面无人操作也可能继续请求。免费额度适合偶尔和朋友玩，不能据此承诺无限房间或全天高频在线。

持久化不替代备份。可通过标准 Postgres 工具 `pg_dump` 导出完整数据库，连接信息在自己的 Neon 控制台获取；备份含玩家会话与隐藏对局数据，应保存到私密位置，不上传到公开 GitHub 仓库。恢复或迁移时必须同时保留两张表以及其中的元数据，不要只复制房间记录。恢复验证宜使用独立测试分支，确认无误后再切换正式后端。项目的 `npm run backup` 只备份可选 SQLite 后端，不用于 Neon。

## 验证范围

本地持久化套件使用 PGlite 执行 PostgreSQL SQL、JSONB 和事务。已通过的基础验证覆盖落盘后重新打开、身份与隐藏行动保留、空闲恢复、普通实例替换不延长计时、12 人匹配、回滚、写入失败、不合法行动、损坏数据与连接失败等情形。完整测试范围及结果以当前代码运行结果为准：

```bash
node --test tests/neon-persistence.test.js
```

PGlite 测试连接由测试池串行租用，不能证明真实 Postgres 多连接锁竞争、Neon 基础设施恢复或公网联机已经通过。发布后还应从两个独立浏览器会话验证同房、聊天与身份隔离，并在测试房间保留行动后重新部署 Function，验证恢复；长时间全站无业务请求后的恢复也需要线上验证。没有完成这些检查前，不应把本地测试结果表述为“Neon 重启恢复实测通过”。
