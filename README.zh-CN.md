# CCMultiplayerServer(中文)

> [English README](README.md) | 中文版本

[![Discord Server](https://img.shields.io/discord/382339402338402315.svg?label=Discord%20Server)](https://discord.gg/SJmMZKy)

CrossCode 多人模组
[CCMultiplayerClient](https://github.com/CCDirectLink/CCMultiplayerClient)
的**中继服务器**。

它是一个小型的 Node.js + socket.io **消息中继**:客户端之间从不直接通信,
所有的位置/动画/实体更新都先发送到这里,再转发给同一地图上的其他玩家。
服务器还负责选举**主机**(第一个连接的客户端),并在主机掉线时处理**主机迁移**。

> **当前状态:与复活后的客户端兼容。** 服务器与游戏版本无关 ——
> 网络协议在 CrossCode 1.1.0 与 1.4.2 之间没有变化,因此针对 1.4.2 / CCLoader v2 的适配
> **无需改动任何代码**。已用 `socket.io-client@4.8.x` 通过一次真实握手测试重新验证。

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

服务器默认监听 **1423** 端口。可用 `PORT` 环境变量覆盖:

```bash
PORT=8080 npm start
```

然后在客户端的 `config/config.json` 中指向它,例如:

```json
{ "hostname": "你的服务器IP", "port": 1423, "type": "http" }
```

## 工作原理

- `server.js` 建立 HTTP + socket.io 监听,并把每个新连接交给 `user.js` 处理。
- `user.js` 跟踪已连接的用户、他们所在的地图与位置,以及被选出的主机。
  它把模组的事件(`changeMap`、`updatePosition`、`updateAnimation`、`registerEntity`、
  `updateEntity*`、`throwBall`、`killEntity` 等)转发给同一地图上的其他用户。
- `userUtilities.js` / `cmd.js` 提供辅助函数和一个可选的交互式控制台。
- `persistence.js` 将账号、好友关系与云端存档保存在 `data/` 目录。自 **1.71.0**
  起还会为每名玩家保留**最近 5 份不重复的存档镜像**;客户端的「镜像回溯」登录
  流程可通过 `saveMirrorRestore` 流式恢复其中任意一份。
- 自 **1.71.2** 起,`puzzleState` 中继还会放行箱子抓取归属(`own` / `ot`)。
  自 **1.71.3** 起,客户端将台阶板(PushPullDest)与已放置箱子的进度视为
  个人存档状态,不再发送这些内容(旧的 `pl` / `dl` 台阶板字段仍被接受但不再使用)。
- 自 **1.71.7** 起,`questKill` 中继负责任务击杀进度:队伍处于**剧情同步**时
  发送给全队所有在线队员(跨地图);否则只发送给发送者所在的地图实例
  (即同地图玩家才会计数)。
- 自 **1.71.9** 起,`enemySoundStop` 中继会把主机端 `STOP_SOUNDS` 动作转发给
  同实例成员,用来停止循环怪物音效(例如疯牛冲锋的脚步声),避免残留叠加。
- **1.71.10** 为纯客户端 QoL 版本(新增外部UI缩放设置);协议没有变化,
  仅握手版本号同步升级。
- 服务器还会从本地 `./game` 目录在 `/data/*` 与 `/media/*` 路径下提供静态游戏文件
  (仅用于开发;正常作为中继使用时并不需要)。

完整的事件列表见客户端 README 的
[网络协议](https://github.com/CCDirectLink/CCMultiplayerClient#network-protocol)
一节。

## 技术栈

- [Node.js](https://nodejs.org/en/docs/) —— JavaScript 运行时
- [socket.io](https://socket.io/) —— 实时传输
- [express](https://expressjs.com/) —— 静态文件服务
