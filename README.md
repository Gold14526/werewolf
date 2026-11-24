# 狼人杀

一个中文狼人杀网站：默认匹配 12 人标准局，支持自选角色开房、6 位随机房号、文字聊天和服务端裁判。推荐将源码放在自己的 GitHub 仓库，GitHub Pages 提供网页，Neon Functions 提供联机 API，Postgres 保存房间与对局。后端实例回收或重新部署后，使用同一数据库恢复已提交的状态。另保留独立 Node + SQLite 和 Cloudflare Worker + D1 部署方式。

界面与操作流程参考 QOJ 的杀人游戏大厅，改为狼人杀角色配置；游戏引擎与联机服务独立实现，不使用参考站的真实玩家信息、历史战绩或账号数据。

## 包含什么

- 默认 12 人局：4 狼人、4 村民、预言家、女巫、猎人、守卫各 1 人。
- 自定义 6–18 人房间，选择角色数量、阶段时长和胜利条件；可加入狼王、白狼王、愚者、骑士，并勾选「开启上警」。
- 随机生成 6 位数字房号，并在服务端检查当前房号是否重复。
- 自动匹配、房号或邀请链接加入、公开房间列表、准备状态、房主开局。
- 夜间技能、按座位轮流发言、遗言、投票放逐、平票 PK、狼人自爆、猎人开枪和胜负结算。
- 狼队夜间私聊、已结束对局回看、个人战绩和胜场榜。
- 服务端按玩家身份过滤返回数据，未结束时不会把其他玩家的隐藏身份发给客户端。
- 本地体验模式，可先试用界面和规则；本地房间不会向其他设备开放。

当前采用文字交流，没有麦克风语音或账号注册。

## 开始游戏

按 [Neon 部署说明](docs/NEON.md) 发布后端，再完成下方 GitHub Pages 部署并设置 `API_BASE_URL`，即可从自己的 Pages 网址联机。代码保存在 GitHub，实时对局数据保存在 Postgres，二者独立。仅部署静态页面时，真人匹配和共享房间尚不可用；本文提供部署方法，不代表后端已经上线。

- **快速匹配：**点击「开始匹配」，12 名真人进入同一队列后自动开局。
- **好友开房：**点击「自选配置开房」，选择角色、时限及是否开启上警，再把 6 位房号或「复制邀请链接」得到的网址发给朋友。邀请链接形式为站点路径加 `?room=123456`，打开后会显示加入确认。
- **开始对局：**所有玩家准备后，房主点击「开始游戏」。
- **断线恢复：**页面会显示断线状态并自动重连；刷新同一标签页可以恢复原座位。

「本地试玩」是单独的电脑演示，不会加入真人队列。

## 先在自己的电脑上运行

安装 **Node.js 22.13 或更新版本**，在项目根目录运行：

```bash
npm start
```

浏览器访问终端输出的地址。此时网页与联机 API 由同一个 Node 服务提供，不需要设置外部 API 地址。这条本地 Node + SQLite 路径只使用 Node 内置模块，可直接启动；构建 Neon 后端或运行完整测试前需要 `npm ci` 安装依赖。

数据库默认写入 `data/moonwolf.sqlite`，也可通过 `DATABASE_PATH` 指定路径。再次启动同一数据库即可恢复已保存状态。正式部署必须把数据库所在目录挂载到持久磁盘或 Docker 卷；容器内的临时目录、免费服务的易失磁盘和 GitHub Actions 工作目录都不能满足重启与重新部署后保留数据的要求。

安装依赖、测试并生成 GitHub Pages 静态文件（持久化测试使用 Node 内置 SQLite 和本地 PGlite）：

```bash
npm ci
npm test
npm run build
```

`dist/` 是构建结果；修改源码时请编辑 `web/`。请通过 HTTP 服务打开页面，不要直接双击 `index.html` 使用 `file://`。

同一浏览器配置下，新开的标签页共享该服务器的玩家身份，每个标签页可单独选择正在参与或观战的房间。一个玩家同时只能占用一局玩家席。原标签页已有的旧会话可继续使用。清除站点数据或更换设备后，需要重新建立游客身份。

## 部署到 GitHub Pages

GitHub Pages 托管的是 HTML、CSS、JavaScript 等静态文件，不能运行本项目的 Node 联机进程。可以先部署前端体验，再接入后端；仅上传前端不会产生跨设备共享的房间。

1. 使用 GitHub 仓库 `Gold14526/werewolf`；自行复制项目时也可以使用其他仓库名。
2. 将本项目的**根目录内容**提交到仓库的 `main` 分支，确保 `package.json` 和 `.github/workflows/pages.yml` 位于正确位置。上传文件时不要漏掉隐藏的 `.github` 目录，也不要把 ZIP 压缩包直接当作网站文件上传。
3. 在仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。
4. 在 **Actions** 中运行 **Deploy GitHub Pages**，或向 `main` 再提交一次修改。
5. 工作流成功后，在 **Settings → Pages** 查看实际访问地址。本仓库默认地址为 `https://gold14526.github.io/werewolf/`，是否已发布以 Pages 设置和 Actions 结果为准。

如果使用 Git 命令，先将下方地址换成自己的仓库：

```bash
git init
git add .
git commit -m "Add Moonwolf game"
git branch -M main
git remote add origin https://github.com/Gold14526/werewolf.git
git push -u origin main
```

如果你的默认分支不是 `main`，同步修改 `.github/workflows/pages.yml` 的 `on.push.branches`。

### 让所有访问者连接同一台后端

后端上线后，在 GitHub 仓库 **Settings → Secrets and variables → Actions → Variables** 新建仓库变量：

| 名称 | 示例 |
| --- | --- |
| `API_BASE_URL` | Neon Function 发布结果中的 HTTPS 根地址，或所选其他后端的 HTTPS 根地址。 |

填写后端的 **HTTPS 站点根地址**，不要加 `/api`。重新运行 Pages 工作流后，所有访问者会默认使用这个后端。API 地址是公开配置，不是密钥。

也可以在网页中的「联机设置」临时填写 API 地址；该设置仅影响当前浏览器。若临时配置覆盖了新的默认地址，请在联机设置中更新或清除旧值。

## 部署联机服务

### 推荐：Neon Functions + Postgres

前端继续使用自己的 GitHub Pages，后端只需一个 Neon 项目。Neon Functions 执行联机 API，Postgres 持久保存状态，不需要购买常驻 Node 实例或挂载 SQLite 磁盘。免费计划有算力、调用次数和流量额度；额度用尽可能暂停服务，适合小规模组局，具体限制以 [Neon 官方计划](https://neon.com/docs/introduction/plans) 为准。

推荐在浏览器中把 Neon 项目连接到自己的 GitHub 仓库；安装 Neon 官方 GitHub App 时只选择这个仓库。集成会自动设置仓库 Secret `NEON_API_KEY` 和 Variable `NEON_PROJECT_ID`，再添加 Variable `NEON_BRANCH_ID` 指向已有生产数据库分支。

在 **Actions → Deploy Neon API → Run workflow** 选择 GitHub 的 `main`，把 `neon_branch` 填成目标 Neon 分支 ID 或准确名称。工作流自动测试、构建、发布，并验证本次活动版本的 Postgres 健康状态；成功后从 Summary 复制 API 根地址，设置 `API_BASE_URL` 并重新运行 Pages 发布。

后续若要自动发布，将仓库 Variable `NEON_DEPLOY_ENABLED` 设为 `true`。手动和自动发布都只允许 GitHub `main` 分支；自动发布只响应工作流列出的后端相关文件变化。目标 Neon 分支必须已经存在，工作流不会创建或删除数据库分支。完整浏览器配置、分支选择和恢复验证步骤见 [docs/NEON.md](docs/NEON.md)，不需要另行登录本地 CLI。

本地开发时也可单独构建：

```bash
npm ci
npm run build:neon
```

构建生成 `dist-neon/index.mjs` 和 `dist-neon/werewolf.zip`；`neon.ts` 保留可选 Neon CLI 配置。构建成功仅说明产物已生成，不代表接口已上线。

### 可选：独立 Node + SQLite 服务

在支持长时间运行 Node.js 或 Docker、并提供持久磁盘的主机运行 `npm start`。它同时托管前端和 API；不需要 GitHub Pages 时可直接分享该服务地址。`DATABASE_PATH` 必须指向持久磁盘上的 SQLite 文件。代码重新拉取或镜像替换不会迁移数据库，重新发布时必须继续挂载同一份磁盘。

当前 SQLite 后端只运行一个服务实例。多实例需要另外实现独立持久数据库、并发控制与统一房间路由，不能让多个实例各自保存一份房间状态，也不能直接共用此实现的数据库文件。

### 可选：使用 Render

本项目提供 `render.yaml`，可连接 GitHub 仓库后作为 Render Blueprint 导入。配置使用原生 Node.js 24、`starter` 付费实例，并挂载 1 GB 持久磁盘到 `/var/data`；构建命令为 `npm ci --omit=dev`，启动命令为 `node server/index.mjs`。实际套餐、磁盘费用和最终账单以平台创建页面为准，需账号所有者确认费用并完成购买；提交配置文件本身不会代付或开通服务。

手动创建时，务必添加上述持久磁盘，并设置 `DATABASE_PATH=/var/data/moonwolf.sqlite`。免费实例或不带持久磁盘的容器不满足本项目的数据保留要求。运行一个实例，并在每次重新部署时保留原磁盘。

在后端设置环境变量：

| 变量 | 用途 |
| --- | --- |
| `PORT` | 服务监听端口；部署平台通常自动提供。 |
| `HOST` | 监听地址，部署时使用 `0.0.0.0`。 |
| `DATABASE_PATH` | SQLite 文件路径。Render 填 `/var/data/moonwolf.sqlite`；父目录必须在持久磁盘上。 |
| `ALLOWED_ORIGINS` | 允许调用 API 的网页来源，多个来源用逗号分隔。 |

例如 GitHub Pages 地址是 `https://alice.github.io/moonwolf/`，则允许来源应填 **`https://alice.github.io`**，不包含 `/moonwolf/` 路径。若前端使用自定义域名，应填写该域名的完整来源，例如 `https://play.example.com`。

```text
ALLOWED_ORIGINS=https://alice.github.io,https://play.example.com
```

部署完成后，打开 `https://你的后端地址/api/health` 检查服务状态，然后把后端地址填到 GitHub 的 `API_BASE_URL`。GitHub Pages 使用 HTTPS，后端也必须启用 HTTPS，否则浏览器会阻止混合内容请求。

### 可选：使用自己的服务器

可以用进程管理器持续运行 `npm start`，在前面配置 HTTPS 反向代理；也可以使用 Docker：

```bash
docker build -t moonwolf .
docker volume create moonwolf-data
docker run --name moonwolf --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  -v moonwolf-data:/var/data \
  -e PORT=3000 \
  -e HOST=0.0.0.0 \
  -e DATABASE_PATH=/var/data/moonwolf.sqlite \
  -e ALLOWED_ORIGINS=https://你的用户名.github.io \
  moonwolf
```

也可使用仓库中的 `compose.yaml` 启动。上述命令与 Compose 均只在 `127.0.0.1:3000` 提供 HTTP，公网访问需配置 HTTPS 反向代理。升级镜像时保留原数据卷，不要执行删除数据卷的命令。数据库、备份及 SQLite 的相关文件都属于私有游戏数据，不应提交到公开 GitHub 仓库。

### Cloudflare Worker + D1 备选

如果使用自己的 Cloudflare 账号，也可部署 Worker + D1；它与 Neon 是两套独立后端，所有玩家应统一连接选定的一套。

`worker/` 是联机后端，`db/schema.ts` 定义持久化结构，`drizzle/` 保存已生成的数据库迁移。Worker 同时包含网页和 API，D1 保存房间、会话和对局数据。GitHub Actions 可以在源码更新后自动测试、迁移数据库并发布 Worker。

先在自己的 Cloudflare 账号创建一个 D1 数据库，建议命名 `werewolf-db`。记录它的 Database ID 和账号的 Account ID，再准备仅用于该账号 Worker 发布和 D1 访问的 API Token。Token 只能放入 GitHub Actions Secrets，不要提交到源码或填写到网页的联机地址中。

在仓库 **Settings → Secrets and variables → Actions** 设置：

| 类型 | 名称 | 内容 |
| --- | --- | --- |
| Secret | `CLOUDFLARE_API_TOKEN` | Cloudflare API Token。 |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID。 |
| Variable | `CF_DATABASE_ID` | 已创建的 D1 Database ID，UUID 格式。 |
| Variable | `CF_DATABASE_NAME` | 可选，默认 `werewolf-db`，应与已创建数据库名称一致。 |
| Variable | `WORKER_NAME` | 可选，默认 `werewolf-api`。 |
| Variable | `ALLOWED_ORIGINS` | 可选，额外允许的前端来源，多个以逗号分隔；工作流自动加入仓库所有者的 GitHub Pages 来源。 |
| Variable | `CLOUDFLARE_DEPLOY_ENABLED` | 配置完成后设为 `true`，启用后端自动发布。 |

在 **Actions** 中运行 **Deploy multiplayer backend**，成功后从日志获取 Worker HTTPS 地址。访问其 `/api/health` 确认服务可用，再将根地址写入前述 `API_BASE_URL` 并重新运行 Pages 发布工作流。没有配置 Cloudflare 时，后端工作流会跳过，不影响静态页面发布。

本地构建 Worker：

```bash
npm ci
npm run build:cloudflare
```

构建输出 `dist/server/index.js`，包含网页和 API。数据库通过 `DB` 绑定提供给 Worker；工作流生成的 Wrangler 配置指向 `drizzle/` 迁移目录。数据库结构有变化时运行 `npm run db:generate`，审查并提交新迁移；不要修改已经应用的迁移文件。

`npm run build` 生成 GitHub Pages 静态文件，`npm run build:cloudflare` 生成 Worker，两者都写入 `dist/`。分别构建和发布，不要混用输出。Neon 构建使用单独的 `dist-neon/` 目录。

如果使用自定义域名，须把其完整来源加入 `ALLOWED_ORIGINS`。例如网页地址 `https://play.example.com/werewolf/` 对应来源 `https://play.example.com`，不包含路径。

### 数据保存与容量

| 项目 | Neon Functions + Postgres | Node + SQLite 持久磁盘版 | Worker + D1 备选 |
| --- | --- | --- | --- |
| 房间、身份、会话、聊天、历史和战绩 | 存入 Postgres，实例回收或重新发布后从同一数据库读取 | 存入 SQLite；重启或重新发布时继续挂载同一数据库即可恢复 | 存入 D1，Worker 重启或重新发布后保留 |
| 活动房间 / 会话上限 | 20 / 500 | 1000 / 10000 | 20 / 500 |
| 已结束对局 | 至多最近 20 场，容量不足时减少 | 最近 100 场 | 至多最近 20 场，容量不足时减少 |
| 每房间聊天 | 最近 400 条；房间记录过大时进一步移除旧消息 | 最近 2000 条 | 最近 400 条；房间记录过大时进一步移除旧消息 |

Neon 每次业务请求都在 Postgres 事务内锁定元数据、读取状态并提交修改，提交成功后才返回成功；并发实例通过数据库锁协调。连接或写入失败时返回 503，不切换为内存存储。实例替换本身不会重置阶段计时；全站业务活动中断超过 60 秒时，下一次业务请求把整个间隔视为暂停，恢复阶段剩余时间且至少留 30 秒操作时间，并提供 2 分钟重连宽限。健康检查不推进游戏时钟；若其他玩家仍在请求，单个离线房间不会因此暂停。详见 [Neon 恢复与验证说明](docs/NEON.md#数据保存与恢复)。

Node 服务在成功操作响应前提交 SQLite 事务；游戏计时推进也会保存。服务重启从最后一次已提交的状态恢复，停机时间不计入阶段倒计时和离线清理期限；进行中阶段恢复剩余时长，至少留 30 秒操作时间，房间和会话另有 2 分钟重连宽限。存储写入失败或出现状态冲突时服务停止接受操作并返回 503，不会把未保存的操作报告为成功。修复存储问题后需重启服务。

Neon 与 D1 版会在房间记录超过约 220 KiB 时裁剪旧聊天；全部业务状态上限为 10 MiB，超出容量时会拒绝操作并提示稍后重试。这些是应用自身的限制，与托管平台的数据库额度不同。适合朋友组局和小规模匹配；大量公开用户需要进一步拆分存储和扩容。

保留上限和正常运行期间的清理规则仍然生效：等待中的玩家超过 2 分钟无活动会移出房间，房间整体闲置超过 30 分钟会清理，会话闲置超过 24 小时失效；Neon 和 Node 恢复时适用上述暂停与宽限。已按规则清理的数据不会因为重启重新出现。Neon 与 D1 版由客户端请求推进已到期阶段；D1 版没有 Neon 的全站空闲恢复机制。持久化不表示无限保留历史。

公开房间的结束记录可由任意会话查看；私密房间的结束记录仅该局参与者可查看。结算后才公开所有身份、保留的狼队聊天和夜间行动记录。夜间复盘包括守护目标、每名狼人的刀人票与最终刀口、查验目标与结果、女巫用药情况。

战绩跟随玩家会话累计，昵称不是唯一账号，也不支持跨设备凭昵称找回。重启后应在原浏览器标签页恢复会话；清除浏览器会话、删除或更换数据库后，不会自动找回原身份。请定期备份数据库；数据库持久化不替代灾难恢复备份。

使用可选 Node + SQLite 服务时，可在运行中生成一致的备份（Neon 的 Postgres 备份方法见部署说明）：

```bash
npm run backup -- /absolute/new-backup.sqlite
```

源数据库默认是 `data/moonwolf.sqlite`，若服务使用 `DATABASE_PATH`，执行备份时也须设置同一变量。目标必须是一个不存在的绝对路径，命令拒绝覆盖已有备份。成功后应将备份另存到外部存储，并定期验证恢复；仅留在原服务器同一块磁盘上不能防止磁盘丢失。

## 本项目采用的规则

不同线下桌游的细则并不完全相同，以下为本实现约定：

| 项目 | 规则 |
| --- | --- |
| 标准配置 | 4 狼、4 民、预言家、女巫、猎人、守卫各 1 人；默认不开启上警。 |
| 自选配置 | 6–18 人；狼队至少 1 人且少于总人数的一半，狼王与白狼王计入狼队；普通狼人至多 6 人，村民至少 1 人，每种特殊身份至多 1 人。愚者与骑士属于神职，「屠边」配置至少包含 1 个神职。 |
| 夜间顺序 | 狼队、守卫和预言家同时行动，女巫在狼队截止后行动。普通视角只看到整夜总倒计时。已配置角色出局后仍保留原定时间。 |
| 守卫 | 可守护一人，不能连续两夜守护同一人。 |
| 女巫 | 解药和毒药各一瓶，每夜最多使用一种。默认仅首夜可自救，开房也可选择禁止自救或允许每夜自救。解药须点名被刀者，空刀时显示无人被刀，毒药可选任一存活玩家。守护与解药同时落在刀口上时该玩家仍会死亡，毒药无视守护。 |
| 狼人刀人 | 存活狼人各自投票，唯一最高票成为刀口；并列或全部放弃则无人被刀，可以选择狼队友。 |
| 猎人 | 符合开枪条件时可带走一人；被毒杀或白狼王带走不能开枪。 |
| 狼王 | 与狼人共同夜间行动、共享狼队私聊；出局后可开枪带走一人，但被毒杀、自爆、被骑士决斗或被白狼王带走时不能开枪。 |
| 白狼王 | 与狼人共同夜间行动；可在警上发言或白天放逐发言阶段自爆并选择带走一人，被带走者不能发动死亡技能，双方均无遗言。正常出局不能带人，投票和遗言阶段不能自爆。 |
| 愚者 | 第一次被放逐时翻牌免死，之后仍可发言，但不能投票，也不再成为放逐目标；仍可被夜间袭击、毒药或其他技能淘汰。翻牌时若持有警徽，警徽流失。 |
| 骑士 | 白天放逐发言阶段可翻牌发动一次决斗。目标为狼队则目标出局并进入下一夜，狼王不能因此开枪；目标为好人则骑士出局，目标存活，之后继续原发言流程。 |
| 白天 | 无警长时按座位升序逐个发言；有警长时由警长选择警左或警右开始，并由警长最后发言。每人独立计时，可提前「过」。只有当前发言者能发送公开消息；其他人可先写草稿。 |
| 挂机 | 轮到发言后连续 60 秒未键入判定挂机，最后 15 秒在发言框下提示。挂机玩家后续发言限时 2 秒，可点「回到游戏」恢复。 |
| 座位与观战 | 开局前点击空位入座或换座，也可转入观战。开局默认保留座次，可在建房时开启随机重排。满员后加入会自动观战，出局后自动转观战并保留原座，可同时加入其他局的玩家席。 |
| 上警 | 房主创建房间时可勾选。首夜结束后、公布死讯前报名竞选并依次发言，可退水；只有最初未上警的玩家投票，退水者不能投票。无人竞选则无警长，仅一人竞选则直接当选；平票者发言后重投，再次平票则无警长。 |
| 警徽 | 警长的放逐票计 1.5 票，竞选投票仍为每人 1 票。警长出局可移交给其他存活玩家（已翻牌的愚者除外），或主动撕毁；超时按撕毁处理。 |
| 警上自爆 | 采用单次自爆吞警徽：警上发言期间狼人自爆使本局警徽流失；结算尚未公布的首夜死亡及相应技能、遗言后入夜，不进行当天放逐。 |
| 遗言 | 首夜出局者和白天被放逐者有遗言；猎人开枪带走的玩家在首夜或白天也有遗言。其他夜晚的死者没有遗言。 |
| 投票 | 存活玩家同时投票，点击头像投票，可弃权，不能投自己。截止前可在头像与弃权之间反复改选，结束后公布最终票型。 |
| 平票 PK | 首轮最高票并列时，仅平票玩家依次发言；随后重投，只能投给平票玩家，平票玩家不投票。第二轮仍平票或无人投票，则无人出局。 |
| 狼队私聊 | 仅存活狼人可在「狼人行动」阶段发送队内消息；好人看不到未结束对局的狼队聊天，狼人可见队友当轮刀人选择。 |
| 狼人自爆 | 存活狼人可在白天发言或投票阶段自爆，公开狼人身份并出局，立即结束当天进入黑夜；遗言阶段不可自爆。 |
| 好人胜利 | 所有狼人出局。 |
| 狼人「屠边」 | 村民全部出局，或神职全部出局。 |
| 狼人「屠城」 | 所有好人出局。 |
| 平局 | 阵营胜负优先。其余情况下全体存活玩家均已挂机，或完成第 20 天仍未分胜负，判平局。 |
| 超时 | 未提交的技能和投票按放弃处理，避免房间因离线而永久卡住。 |
| 阶段时长 | 狼队行动可选 60、75、90 秒，默认 75 秒。其他行动可选 30、40、50 秒，默认 30 秒。发言及遗言独立设置为 60、90、120 秒，默认 90 秒。升级前房间原设行动时间沿用为狼队时间，其他行动取 30 秒。 |

实际身份、技能目标、行动结果与胜负均由联机服务校验。房号只用于找到房间，不是账号密码；请只把邀请房号分享给打算一起玩的朋友。

## 常见问题

**页面可以打开，但朋友搜不到房间。**

检查是否误选了本地试玩，以及朋友是否有访问站点的权限。所有人必须连接同一个后端；分享不同部署的网址会进入不同队列。

**已设置 API 地址，仍连接失败。**

检查 `/api/health`、HTTPS、后端是否在线，以及 `ALLOWED_ORIGINS` 是否与网页的来源完全相同。来源包含协议和端口，不包含路径。托管服务休眠后首次连接可能需要等待启动。

**Pages 页面空白或资源 404。**

检查 Actions 是否成功，发布来源是否为 GitHub Actions，源码是否多嵌套了一层文件夹。静态资源使用相对路径，可用于仓库子路径。

**为什么不能直接靠 GitHub 仓库同步房间？**

GitHub 保存源码和自动部署配置，GitHub Pages 提供静态网页，实时对局由后端数据库保存。Pages 没有常驻游戏进程。多人匹配、随机身份和隐藏信息需要所有玩家共同连接一个受控服务；不能通过公开仓库文件安全地承担这些职责。

**为什么用了 SQLite，重新部署后仍可能丢数据？**

SQLite 是数据库文件，文件必须位于平台的持久磁盘上。检查 `DATABASE_PATH`、磁盘挂载路径和重新部署时是否使用原磁盘；只选择付费实例而不挂载持久磁盘仍不足以保证数据保留。

## 代码位置

| 路径 | 内容 |
| --- | --- |
| `web/` | 页面、样式、交互及静态配置。 |
| `web/engine.js` | 浏览器体验与服务端共用的规则引擎。 |
| `neon/index.mjs`、`neon/store.mjs`、`neon/schema.sql` | Neon Function 入口、Postgres 事务与恢复逻辑、数据库结构。 |
| `neon.ts`、`scripts/build-neon.mjs` | Neon CLI 配置及 Function 构建。 |
| `.github/workflows/neon.yml`、`scripts/deploy-neon.mjs` | 从 GitHub 发布 Neon Function，并确认本次版本与 Postgres 健康状态。 |
| `docs/NEON.md` | GitHub Pages + Neon 部署、恢复语义及验证范围。 |
| `server/index.mjs` | 独立 Node 联机服务及 SQLite 持久化。 |
| `worker/` | Cloudflare Worker API、并发控制和 D1 数据存储。 |
| `db/schema.ts`、`drizzle/` | 数据库结构和版本化迁移。 |
| `tests/` | 规则与服务器测试。 |
| `scripts/build.mjs` | 生成 GitHub Pages 静态网站。 |
| `scripts/build-hosted.mjs` | 生成带联机服务的 Worker 网站。 |
| `scripts/configure-cloudflare.mjs`、`wrangler.example.json` | 从非敏感配置生成自己的 Cloudflare 部署设置，以及手动配置示例。 |
| `.github/workflows/pages.yml` | GitHub Pages 自动发布。 |
| `.github/workflows/cloudflare.yml` | Cloudflare Worker 测试、D1 迁移与自动发布。 |
| `Dockerfile`、`render.yaml`、`compose.yaml` | 带持久数据卷的后端部署配置。 |

部署平台的使用说明：[GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)、[GitHub Pages 工作流](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)、[Neon Functions](https://neon.com/docs/compute/functions/overview)、[Neon 计划与额度](https://neon.com/docs/introduction/plans)、[Cloudflare GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)、[Cloudflare D1](https://developers.cloudflare.com/d1/get-started/)、[Render Web Services](https://render.com/docs/web-services)。

代码按 [MIT License](LICENSE) 开源。
