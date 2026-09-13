# CCMultiplayerServer-Next(中文)

> [English README](README.md) | 中文版本

[![Discord Server](<https://img.shields.io/discord/382339402338402315.svg?label=Discord%20Server>)](https://discord.gg/SJmMZKy)

CrossCode 多人模组
[CCMultiplayerClient-Next](https://github.com/LyceenAiro/CCMultiplayerClient-Next)的**中继服务器**，Fork自[CCMultiplayerServer](https://github.com/CCDirectLink/CCMultiplayerServer)。

它是一个 Node.js + socket.io **消息中继**与**会话权威**：客户端之间从不直接通信。
位置 / 动画 / 实体 / 战斗更新会先发送到这里，再转发给同一地图实例上的其他玩家。
服务器还负责选举**主机**、在主机掉线时**迁移主机**，并托管账号、云端存档、组队、好友、交易与管理工具。

> **当前版本：3.0.3**，须与客户端握手版本一致。
> 服务器与游戏版本无关（CrossCode 1.1.0 与 1.4.2 的线协议风格一致），
> 但 Next 分支在原版中继之上做了大量扩展 —— 见下文功能说明。

## 环境要求

- [Node.js](https://nodejs.org/en/download/) ≥ 14

## 安装

```bash
npm install
```

## 运行

```bash
npm start
# 或者: node server.js
```

默认监听端口为 **15151**（`config.json` → `port`）。可用 `PORT` 环境变量覆盖：

```bash
PORT=8080 npm start
```

然后在客户端的 `config/config.json` 中指向它，例如：

```json
{ "hostname": "你的服务器IP", "port": 15151, "type": "http" }
```

## 工作原理

- `server.js` 建立 Express + socket.io，加载配置，并装配
  `protocol.js` / `admin.js` / 静态游戏文件路由。
- `protocol.js` 是主要的 socket 接口：握手、地图实例、实体与战斗中继、
  社交/交易、存档流、ping 等。
- `world.js` 管理地图实例、主机选举与主机迁移。
- `party.js` / `friends.js` 处理队伍名册与好友列表。
- `accounts.js` + `persistence.js` + `savecodec.js` 将账号、密码、好友关系
  与云端存档保存在 `data/` 目录。
- `traffic.js` 按区域类型（野外 / 城镇）限制高频转发流的速率。
- `config.js` 读取 `config.json`（文件缺失时回退到安全默认值）。
- 可选的本地 `./game` 目录会在 `/data/*` 与 `/media/*` 下提供静态文件
  （仅用于开发；正常作为中继使用时并不需要）。

### 服务端主要能力

- **账号与云端存档** —— 登录时流式下发 auto-slot 存档；上传分块且限速。
  可选账号密码与锁定状态。
- **存档镜像** —— 每名玩家保留最近 **5 份不重复存档镜像**，客户端可通过
  `saveMirrorRestore` 恢复其中任意一份。
- **组队与好友** —— 邀请/接受/退出/踢出、队长转移、好友申请。
- **交易** —— 服务器侧撮合，可配置比率；导入存档 / 镜像回溯后有防刷锁定。
- **进度墙** —— `blockedMaps` 禁止进入未开放地图，并可将已在图内的玩家
  送回安全图（客户端默认回落到远星中枢）。
- **软死亡复活调参** —— 普通战 / Boss 战的复活 HP 比例与倒计时，经握手下发。
- **怪物缩放** —— 每多一名玩家的 HP / 破防 / 异常 / 攻防敏（及可选抗性）系数。
- **管理网页** —— 设置 `adminToken` 后启用 `/admin`（默认仅本机；
  可用 `adminAllowIps` 放行更多 IP）。
- **挂机踢出** —— 野外 / 城镇分别计时；**maxPlayers** 人数上限。
- **延迟探测** —— `mpPing` / `netPing` 供客户端 HUD 使用。

### 历史版本协议备注

- **1.71.0** 存档镜像；**1.71.2** `puzzleState` 抓箱归属（`own`/`ot`）；
  **1.71.3** 台阶板 / 已放置箱子保持个人存档状态（旧 `pl`/`dl` 仍接受但不再使用）；
  **1.71.7** 剧情同步下 `questKill` 跨地图；**1.71.9** `enemySoundStop` 停止循环怪物音效。

完整事件分组见客户端 README 的
[网络协议](https://github.com/LyceenAiro/CCMultiplayerClient-Next#network-protocol)
一节。

## 配置（`config.json`）

未写出的键会使用默认值。常用项：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `port` | `15151` | 监听端口（`PORT` 环境变量可覆盖） |
| `maxPlayers` | `20` | 最大同时在线 |
| `playerCollision` | `false` | false = 玩家互相穿过 |
| `monsterHpPerPlayer` / `monsterBossHpPerPlayer` | `0.7` / `1.0` | 房间每多一人，怪物/Boss 额外最大生命比例 |
| `monsterAttackPerPlayer` / `Defense` / `Focus` | `0.1` | 攻 / 防 / 敏同样缩放 |
| `monsterStatusThresholdPerPlayer` | `0.6` | 异常条更难打满 |
| `softDeathReviveHpNormal` / `…Boss` | `0.5` / `0.25` | 复活 HP 比例 |
| `softDeathReviveTimeNormal` / `…Boss` | `30` / `30` | 复活倒计时（秒） |
| `perfectGuardBaseMs` / `perfectGuardPingFactor` | `10` / `0.6` | 客机精准防御补偿 |
| `tradeEnabled` / `tradeRatio` / `tradeLockHours` | `true` / `2` / `48` | 交易与防刷锁定 |
| `relayMaxTickField` / `relayMaxTickTown` | `30` / `10` | 高频流最大转发频率（Hz） |
| `healHz` | `1` | 自愈心跳频率 |
| `saveUploadKbS` / `saveDownloadKbS` | `16384` | 存档上下行限速 |
| `afkFieldMinutes` / `afkTownMinutes` | `120` / `720` | 挂机断线时长 |
| `blockedMaps` | `[]` | 进度墙地图 ID（当前：`autumn-fall.path-01`） |
| `adminToken` | 空 | 非空则启用 `/admin` |
| `adminAllowIps` | `[]` | `/admin` 额外放行 IP（本机始终放行） |

修改 `config.json` 后需重启服务器。

## 技术栈

- [Node.js](https://nodejs.org/en/docs/) —— JavaScript 运行时
- [socket.io](https://socket.io/) —— 实时传输
- [express](https://expressjs.com/) —— 静态文件服务与管理页

## 作者 / 贡献者

- **[2767mr](https://github.com/2767mr)** —— [CCMultiplayerServer](https://github.com/CCDirectLink/CCMultiplayerServer) 初始开发
- **[Vankerkom](https://github.com/Vankerkom)** —— [CCMultiplayerServer](https://github.com/CCDirectLink/CCMultiplayerServer) 各类建议
- **[LyceenAiro](https://github.com/LyceenAiro)** —— 后续开发、测试、维护（CCMultiplayerServer-Next）

## 许可证

本项目采用 MIT 许可证 —— 详见 [LICENSE](LICENSE) 文件。
