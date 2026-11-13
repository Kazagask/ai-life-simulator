# 三国演义梗模板 · 讨董一章小样验收报告

> **状态**：草案小样 / 路线 A / T-1 纯 yaml。分支 `feat/sanguo-meme-template`，基点 `5249163`。
> **范围**：只新增一个独立模板目录 `specs/data/templates/sanguo-2010/`；**未改任何既有模板、源码、schema、Spec、ADR，未建迭代四件套，未碰线上**。
> 玩法结构变更：新增独立世界模板（新 id / 新开局 / 事件 / 技能 / 道具 / 补正 / 结局），不改既有引擎行为。
> 存档代价：`jjk-2006` 目录零改动、指纹按目录独立 ⇒ **旧存档不受影响**；但 `sanguo-2010` 目录内任一 yaml 变化会让**本模板**旧档全部拒载（§4 已实证）。
> **2026-11-14 第二轮（§8）**：补上剧本层 —— 7 种身份（含刘备 / 曹操 / 袁绍三条真实人物线）、13 个剧情事件、3 个身份结局，以及用 `npcSpawnRules` 实现的「摇到真人就不刷分身」。主线锚点原样未动。yaml 由 1019 行增至 1604 行，指纹 `e38990a4…` → `d5429b49…` ⇒ **本模板第二轮前的旧存档全部拒载**（`jjk-2006` 旧档仍不受影响）。

---

## 1. 交付内容

| 文件 | 行数（第二轮后） | 内容 |
|---|---|---|
| `world.yaml` | 125 | meta / 历法 / 性别枚举（含「乌角鲨」）/ 心情 / 状态栏 / 6 维属性（含 `tianyi`）/ 资源 / 4 个玩家行动 / **3 条 `npcSpawnRules`（防分身）** |
| `characters.yaml` | 236 | 13 个 NPC + 1 个敌人 + `playerTemplate`；曹操、刘备、孙坚、孙策、公孙瓒、二袁、吕伯奢、荀彧、徐盛、邢道荣、华雄、董卓、乌角鲨 |
| `skills.yaml` | 96 | 7 个技能：基础攻击 + 破军（大宝）/ 伏骑（麹义）/ 虚猲（邢道荣）/ 引兵（祖茂）/ 铁骑（界马超）/ 立牧（刘焉） |
| `items.yaml` | 38 | 陈留大食堂馒头、传国玉玺、乌角鲨幼体 |
| `statuses.yaml` | 60 | 天意侵蚀·精神错乱、集体失焦、天意护体、乌角鲨之威、三国 ELO·胜兵必骄 |
| `events.yaml` | 906 | **25 事件**：开局转盘 + 7 格命数转盘 + 4 条虚构身份开场 + 3×3 条人物线 + 讨董大会 + 7 条支线池 + 天意锚点 + 第二章落点 |
| `opening.yaml` | 49 | 1 个开局 `op-190-chenliu` |
| `endings.yaml` | 94 | 2 个终止条件 + **5 个结局**（通用 / 刘备 / 曹操 / 袁绍 / 隐藏） |
| **合计** | **1604** | 8 个 yaml（第一轮 1019 行，第二轮 +585 行） |

**省略的可选分域**：`equipment.yaml` / `combat-ai.yaml` / `evaluation.yaml`。加载器按文件存在性合并（`templates.ts:25-34, 50-68`），缺文件不报错，已实测通过。小样不需要装备与战斗 AI（池事件无 combat）。

## 2. 机制实现：天意怎么把剧情拉回主线

### 2.1 关键工程发现（比草案 §4.2 的设想更贴合）

草案原设想用「高 `priority` + `once` + `conditions` 的 chain 事件」做锚点。落地时改为 **`source: schedule` + `window.start`**：

- 已核实所有 `source: schedule` 定义在**建世界时**按 `window.start` 一次性换算成绝对分钟实例入队（`packages/game-core/src/v2/scheduler.ts`，测试 `scheduler.test.ts:423`「所有 source: schedule 定义按 window.start 一次性换算为绝对分钟实例」）。
- ⇒ **到点必然触发**。`pool` 是随机抽取、`chain` 是线性推进，两者都不保证「天意一定会发力」；`schedule` 正好对应二创「天降补丁」的必然性。
- 副作用：`once: true` + `priority: 100` + `conditions: [{flag: chapter, eq: 1}]` 保证只收束第一章一次，且优先于池事件。

### 2.2 一章的时序

| 天 | 事件 | 作用 |
|---|---|---|
| 0 | `ev-opening-wheel` → `ev-wheel-fate`（4 扇区）→ `ev-tangdong-open` | 命数转盘定出身（诸侯 / 谋士 / 小兵 / **一头乌角鲨**），讨董大会开局 |
| 1–7 | 7 条 `source: pool` 支线 | 随便浪：陈留大食堂、玉玺称帝、笑面虎乌角鲨、乱世害了你、自刎归天、邢道荣、大宝 |
| **8** | **`ev-tianyi-anchor-1`** | `log`「天意发力了」→ `setFlag chapter=2 / anchor1Done=true / mainline=陈留` → `adjustAttribute tianyi -3` → `advanceTo 40 day` |
| 40→41 | `ev-ch2-gate` | 「新三国道」落点，为整条主线留接口 |

**不回滚，只改写认知**（二创「世界修正」原义）：锚点**不清任何 flag、不回滚属性/资源/物品**，只把主线 flag 复位 + `log` 改写叙事。冒烟中玩家 `tianyi` 累积到 **49** 仍保留，玉玺/馒头/乌角鲨仍在，符合设计。

## 3. 梗与三国杀落地

| 点名梗 | 事件 / 位置 | 考据处理 |
|---|---|---|
| 国贼董卓嘛 | `ev-tangdong-open` | 曹操第 1 集原句；注释标「窃听机制」反例（室外大喊必无人听见） |
| 三军听令，自刎归天 | `ev-zifen` | **标注为二创合成句**，并列出两句原始出处（徐州「三军听令，开城迎敌」+ 第 36 集「…自刎归天！」）；另一选项给第 36 集原句 |
| 是这个乱世害了你啊 | `ev-lv-boshe` | 用原句「不是阿瞒害了你，是这个乱世害了你呀」；注明阿瞒/孟德多版本、集数来源冲突，不写死集数 |
| 恭喜爹可以称帝了 | `ev-yuxi` | 孙策对孙坚，第 6 集约 16:15；注明维基语录误归孙坚；兼做「室内密谋必被偷听」正例 |
| 一对笑面虎，两头乌角鲨 | `ev-wujiaosha` | 公孙瓒第 11 集；**魔幻化主投放口**：`genders` 枚举、`item-wujiaosha`、`st-wujiaosha-aura`、敌人 `enemy-wujiaosha`、转盘第四扇区 |
| 是啊吃什么 | `ev-canteen` | **标注为衍生句**，给二创转写句与原剧语序「吃什么！是啊，是啊！」两个选项 |

三国杀侧：6 个技能短句引用并在 `description` 标注武将/技能出处；`ev-daorong`（邢道荣双关）、`ev-dabao`（界徐盛「大宝」，含标徐盛「小宝」彩蛋）。「我剑也未尝不利」属 94 版老三国，未混入。

## 4. 验证集与结果

> 全部本地执行。**未跑项显式标注，不写 PASS。**
> 隔离根位于仓库外 `D:\code\_sanguo_isolated\`（`templates/` + `data/` + 校验脚本），不进 git。
> §7 追加了**局域网试玩入口**（本机临时服务，仅本地，不碰线上）。
> ⚠ 下表是**第一轮**记录，当时指纹 `sha256:e38990a4…`；第二轮改 yaml 后为 `sha256:d5429b49…`，第二轮验证见 §8.3。

| # | 项目 | 命令 / 方式 | 结果 |
|---|---|---|---|
| L0 | 外挂隔离根加载期校验 | `TEMPLATES_DIR=D:/code/_sanguo_isolated/templates` + `check-load.mts` | **PASS** `LOAD OK`，1 套模板，events=12 chars=14 skills=7 items=3 statuses=5 actions=4 chains=0，指纹 `sha256:e38990a4…` |
| L0 | 默认根两套共存 | 不设 `TEMPLATES_DIR` 跑同一脚本 | **PASS** 2 套：`jjk-2006`(指纹 `sha256:d8d81863…`, 109 事件) + `sanguo-2010`；`git status specs/data/templates/jjk-2006/` 为空 ⇒ 旧模板零改动 |
| L1 | `pnpm typecheck` | `corepack pnpm typecheck` | **PASS**（无输出） |
| L2 | shared 测试 | `corepack pnpm --filter @life-sim/shared test` | **PASS 5 files / 67 tests** |
| L2b | game-core 测试 | `corepack pnpm --filter @life-sim/game-core test` | **PASS 33 files / 478 tests**，含 6 种子 × 2 开局整局回归 |
| L4 | 前端构建 | `corepack pnpm --filter @life-sim/web build` | **PASS** `index-DLvGHcIx.js` 357.10 kB，与 R27 全量回归产物 hash 一致 ⇒ 未破坏前端 |
| L5 | 服务启动（隔离根） | `PORT=3917 TEMPLATES_DIR=… LIFE_SIM_DATA_DIR=… tsx apps/server/src/index.ts` | **PASS** `Server listening at http://127.0.0.1:3917` |
| — | HTTP 交互冒烟 | `smoke-tianyi.mjs`：建局 → 开局转盘 → 逐轮推进 → 结局 | **PASS**（详见下） |
| — | 指纹拒载实证 | 改 `endings.yaml` 后重启 | **PASS** 日志 `template_fingerprint_mismatch` / `skipped:1`，旧档正确拒载 |
| — | 云端冒烟 `cloud.smoke.mjs` | — | **未跑**：该脚本判据针对 `jjk-2006` 的 R2.7 响应字段，隔离根只有 sanguo 模板；与本小样无关 |
| — | UI 模板选择器 | — | **未做**：路线 A 明确不改 `apps/web`，见 §6 |
| — | CI / 全量 L0–L5 门禁 | — | **未跑**（本地验证集已覆盖，CI 需推送后触发；本分支未 push） |

### 4.1 HTTP 冒烟明细（seed 42，`op-190-chenliu`）

- `GET /api/templates` → 隔离根只返回 `sanguo-2010` + 开局 `op-190-chenliu`。
- `POST /api/worlds` → 201，初始 `storyChapter=1`、`formattedTime=190年1月1日`、`pendingEvent=ev-opening-wheel`。
- 7 条支线池事件**全部被抽到**（`ev-yuxi / ev-lv-boshe / ev-daorong / ev-wujiaosha / ev-canteen / ev-dabao / ev-zifen`），开局链 `ev-wheel-fate / ev-tangdong-open` 正常。
- **第 8 天 `ev-tianyi-anchor-1` 必然触发**；选择后 `chapter=2`、`formattedTime=190年2月10日`（`advanceTo` 跳到第 40 天）。
- 第 41 天 `ev-ch2-gate` 触发（`190年2月11日`）。
- `endLife: true` → `endingId: end-tianyi-normal`「天意如此」，evidenceIds 含 `ev-tianyi-anchor-1` 与 `ev-ch2-gate`。
- 隐藏结局阈值按本次冒烟修正：原 `tianyi ≥ 12` 会必然命中（实测 41 天已到 49），改为**五条支线 flag 全齐 + `tianyi ≥ 60`**；复跑确认普通结局正常命中，隐藏结局不再变成必得。

## 5. 交付形态与旧机放置

1. **目录自包含**：`specs/data/templates/sanguo-2010/` 8 个 yaml 之间只互相引用，不依赖仓库内任何其它文件；已用 `TEMPLATES_DIR` 外挂到仓库外根目录验证可独立加载。
2. **搬运**：按 `docs/RECOVERY_OLD_MACHINE.md §5`，先做旧机快照，再用 `git format-patch` 导出本分支增量、在旧机隔离分支 `git am --3way` **一次一个提交**；或整目录 + zip 拷过去。**禁止整目录覆盖旧机仓库**。
3. **放置位置**：旧机 `specs/data/templates/sanguo-2010/`（新增目录，不覆盖任何既有文件）。`loadTemplates()` 按子目录自动注册，重启本地服务即可在 `/api/templates` 看到。
4. **本地外挂验证法**（不碰仓库内模板）：把目录拷到外部根 `<root>/sanguo-2010/`，用 `TEMPLATES_DIR=<root>` 启动 server；`LIFE_SIM_DATA_DIR` 也指向仓库外，存档不污染项目。
5. ⚠️ **版本化契约复核**：线上 `GET /api/templates` 已返回 `startVersion / versions[] / assetCount / assetFingerprint / loadable`（见 `docs/RECOVERY_MERGE.md §6.2`），旧机的模板注册与校验机制很可能不同于本地 R2.7。**本小样按本地 R2.7 的 8 文件结构写成，仅为可运行形态验证**；旧机源码找回后，须先核对文件集与 `meta` 结构再决定是否需要适配，不要直接当成最终形态。
6. ⚠️ **指纹**：新增目录不动 `jjk-2006` 指纹；但改动 `sanguo-2010` 目录内任一 yaml 会让**本模板**的旧存档全部拒载（§4 已实证）。

## 6. 已知限制

- **前端只能看、不能选**：`apps/web/src/main.tsx` 建局写死 `templates[0]`（默认根顺序 jjk 在前），路线 A 明确接受；要能从界面选需动 `apps/web` 并先裁决 ADR 边界。
- **只做一章**：主线锚点只有讨董→陈留一处，第二章只有「新三国道」落点占位，无后续事件。
- **天意是「锚点前收束」而非即时打断**：采用草案 §4.2 的退化方案；引擎不支持即时打断当前槽位，也未为此改内核。
- **未验证 `priority` 抢占**：锚点用 `schedule` 保证了必然性，未再测试 `priority` 与已入队随机事件的抢占关系。
- **草案阶段约束**：未建 `specs/iterations/` 四件套（R2.7 仍占位、未正式关闭），未写 ADR，未改契约面，未作任何产品裁决；模板 id / 规模 / 锚点清单仍可改。
- **玩家显示名不会变成历史人物**（第二轮新增）：`setIdentity` 只支持 `gender` / `age`（`packages/shared/src/schema/common.ts:208-214`），**没有改名能力**。roll 到刘备 / 曹操 / 袁绍时年龄改为 29 / 35 / 40、身份由 `origin` flag + 第二人称叙事 + 公开 log 表达；UI 上仍是建局时填的 `playerName`（实测「核对-刘备」）。要让显示名同步得动引擎契约，超出路线 A。
- **三条人物线仍只覆盖第一章**：第二章只有「新三国道」落点占位，人物线在锚点后汇回通用主线。
- **隐藏结局仍很难命中**：阈值「五条 fork flag 全齐 + `tianyi ≥ 60`」是上一轮为防必得而设，实测 41 天侵蚀度约 49，本轮未调阈值。三条人物线都为被排除的池事件补了 fork 来源（§8.2），路径没断，数值门槛依旧偏高。
- **未 push、未部署、未下线**：本分支与线上「咒术转盘人生」实例完全隔离，`docs/RECOVERY_MERGE.md §6.3` 红线继续有效。

---

## 7. 局域网试玩（本机临时入口）

> **访问地址**：`http://192.168.101.13:3000/` —— 手机 / 平板与电脑连**同一个 Wi-Fi**即可打开。
> 2026-11-14 本机 WLAN 的 DHCP 地址是 `192.168.101.13`（网关 `192.168.101.1`），会变；变了用 `ipconfig` 重查。
> 本轮已启动服务并清空试玩存档（`GET /api/worlds` → `{"worlds":[]}`）。**仅本地服务，不涉及线上实例、不执行任何 deploy / unpublish。**
> **第二轮更新**：剧本层 yaml 变更后服务已重启，加载的是 7 格转盘 + 三条人物线的新版本。试玩目录里留着一局第一轮建的存档（`e78a6fae…`，指纹 `e38990a4…`），与新指纹 `d5429b49…` 不符 ⇒ 按 ADR-0007 策略启动期 `skipped` 拒载，界面列表会变空。**这是既定的存档代价，不是故障**：该文件原样保留、未移动未删除，并已只读复制到 `D:\code\_sanguo_isolated\data-smoke\` 备份；想继续玩新剧本请新建一局。

### 7.1 为什么不用改前端就能进三国模板

- `apps/server/src/index.ts:673-705`：**单端口**同时托管 `apps/web/dist` 与全部 `/api`，且 `app.listen({ port, host: "0.0.0.0" })`；`apps/web/src/api.ts` 的 `BASE = ""`，API 全走相对路径 ⇒ 手机无需跨域、无需另起 vite、无需配代理。
- `apps/web/src/main.tsx:680 / 707 / 710`：建局写死 `templates[0]`，回退 id 为 `jjk-2006`（§6 已知限制）。**用 `TEMPLATES_DIR` 外挂一个只含 `sanguo-2010` 的隔离根**，让 `templates[0]` 与 `openings` 自然落到三国模板 —— 这是不改 `apps/web` 的绕法，**不是修复了选择器**。
- ⚠️ 因此**不能用默认根试玩**：默认根两套共存且 `jjk-2006` 排在前面，手机打开会进咒术模板。

### 7.2 启动 / 停止（Git Bash，工作目录为仓库根）

```bash
# 前置（已完成）：corepack pnpm install --frozen-lockfile
#                corepack pnpm --filter @life-sim/web build   # dist 已生成，未改前端源码则不必重跑
rm -rf /d/code/_sanguo_isolated/templates/sanguo-2010
cp -r specs/data/templates/sanguo-2010 /d/code/_sanguo_isolated/templates/
PORT=3000 \
TEMPLATES_DIR='D:/code/_sanguo_isolated/templates' \
LIFE_SIM_DATA_DIR='D:/code/_sanguo_isolated/data' \
./apps/server/node_modules/.bin/tsx apps/server/src/index.ts
```

- 停止：`Ctrl+C`（或结束对应后台任务）。服务只在本机生命周期内有效，电脑休眠 / 会话结束可能中断，重跑上面命令即可。
- **改了任何 yaml 必须重启**：模板是启动期一次性加载（`templates.ts` 的 registry，无 reload / watch）；改前端源码则还需重新 `build`。
- 存档写在仓库外 `D:\code\_sanguo_isolated\data\`，不污染项目；本轮 3 个冒烟存档**移到** `data-smoke/` 保留，未删除。

### 7.3 本轮验证（全部走 `192.168.101.13`，非回环）

| 项目 | 结果 |
|---|---|
| `GET /`（回环 + 局域网 IP） | **200** `text/html`，957 B |
| `GET /api/templates` | **200**，只返回 `sanguo-2010` + 开局 `op-190-chenliu` |
| `GET /assets/index-DLvGHcIx.js` | **200** `text/javascript`，357101 B |
| `GET /health` | **200** `{"ok":true,"protocol":"v2"}` |
| 完整交互冒烟（`lan-smoke.mjs`，局域网地址） | **TIANYI SMOKE OK**：建局 → 7 条支线 → 第 8 天天意锚点 → `chapter=2` / 跳到 190年2月10日 → 第 41 天 `ev-ch2-gate` → `endLife` 得「天意如此」，与 §4.1 一致 |
| 监听 / 防火墙（只读） | 监听 `0.0.0.0:3000`；WLAN `NetworkCategory=Public`；`node.exe` 入站规则 `Allow / Public / TCP Any`，且监听进程路径正是该 `node.exe` ⇒ 入站放行条件满足 |
| 重启后世界列表 | **200** `{"worlds":[]}`（干净试玩列表） |

**未验证 / 注意**：
- **未做真机手机浏览器点击验证**（本机无设备）；上面是 HTTP 层与服务状态验证。若手机打不开，先查：路由器 AP / 客户端隔离、电脑防火墙弹窗是否点了「允许」、IP 是否已变、两端是否同一网段。
- 云端登录 / LLM 叙事未测：登录非建局必需（未登录只提示「可存档到人生档案」）；本模板叙述 `source: template`，不依赖 LLM。
- 页面里的「咒术」字样只在源码注释与转盘配色说明中（`main.tsx:1108 / 1206`），不是玩家可见文案。
- 本机是 HTTP 非 HTTPS，部分浏览器对 PWA 安装有限制，但普通网页试玩不受影响。

---

## 8. 第二轮 · 剧本层（七种身份 / 三条人物线 / 防分身）

> 用户要求：「把故事写出来，别纯堆砌梗；主人公不同身份不同剧情，主线不变；主人公也可以摇骰子摇出真实历史人物；先做刘备 / 曹操 / 袁绍；**开局隐藏 NPC roll 出真实人物就别刷出分身来**」。
> 本轮仍是**路线 A / 纯 T-1 yaml**，未改任何 `packages/**`、`apps/**`、schema、Spec、ADR，未建迭代四件套，未碰线上。

### 8.1 剧本结构：先讲人，再放梗

命数转盘从 4 格扩到 **7 格**，每格一个 `nextEventId`，走自己的开场，最后全部汇入同一场 `ev-tangdong-open`（讨董大会）⇒ 第 8 天天意锚点 ⇒ 第 41 天新三国道。**七条故事的差别在处境、选择、目标（`objective` flag）和结局，主线一段没改。**

| 转盘结果 | 专属事件链 | 故事弧 | 结局 |
|---|---|---|---|
| 一路诸侯 | `ev-intro-lord` | 有一面旗、二十来个人、没粮也没名分 → 插旗 / 借粮 / 争座次 | `end-tianyi-normal` |
| 帐下谋士 | `ev-intro-advisor` | 三封没送出去的信，先数谁开口时别人会安静 → 投袁 / 投曹 / 谁也不投 | 同上 |
| 一个普通小兵 | `ev-intro-soldier` | 抬席子的人在三步之内，听见里屋压得极低的话 → 偷听 / 摸馒头 / 上报 | 同上 |
| 一头乌角鲨 | `ev-intro-shark` | 席位上放一盆水没人觉得不对 → 游进帐 / 去后厨 / 等第八天 | 同上 |
| **刘备**（29 岁） | `ev-line-liu-1/2/3` | **末席**（想替路上的人问一句却总被敬酒）→ **中山靖王之后**（名分先到、兵还没点齐）→ **战至最后一刻**（想退场，却总被签字、开拔这类小事叫回来） | `end-tianyi-liubei`「还是得带着他们走」 |
| **曹操**（35 岁） | `ev-line-cao-1/2/3` | **洛阳来的一个人**（刺董没成、要把散掉的人拢成能打的兵）→ **伯父**（夜里独白：认下来，还是把责任交给世道）→ **没喊出口的四个字**（明知没人听见，也要留个记录） | `end-tianyi-caocao`「留个记录」 |
| **袁绍**（40 岁） | `ev-line-yuan-1/2/3` | **主位**（人人等一句话，他先问座次）→ **体面**（按住要发作的弟弟，假装没看见那头乌角鲨）→ **一句没说出口的军令**（「再等等」转三圈，出口变成「诸位以为如何」） | `end-tianyi-yuanshao`「主位」 |

**梗的用法变了**：三条人物线各只留 1~2 处考据句且都服务人物 —— 刘备线用第 36 集**原句**「列位弟兄，随我接战，战至最后一刻」（不用二创合成句）、曹操线用「不是我害了你，是这个乱世害了你」写成自辩戏、袁绍线用第 11 集「一对笑面虎，两头乌角鲨」写成兄弟处境。大会旁白改成不指名（`有人高声喊出了那四个字`），玩家是曹操时「有人」就是自己。原先 7 条「支线池」仍负责随便浪，但不再承担全部叙事。

### 8.2 防分身：三层，全部纯 yaml

1. **实例层**：`world.yaml` 新增 3 条 `npcSpawnRules`（ADR-0022）⇒ `npc-liubei` / `npc-caocao` / `npc-yuan-shao` 开局 `lifecycle=unspawned`，**不上人物面板、不进自主行动、不参战**。转盘每格的 `effects` 用 `spawnNpc` 显式刷人，玩家是谁就不刷谁：

   | 玩家 | spawn 的规则 | 结果 |
   |---|---|---|
   | 刘备 | `caocao` + `yuan-shao` | 帐里没有第二个刘备 |
   | 曹操 | `liubei` + `yuan-shao` | 帐里没有第二个曹操 |
   | 袁绍 | `liubei` + `caocao` | 帐里没有第二个袁绍 |
   | 4 种虚构身份 | 三人全部 | 三名 NPC 正常在场 |

   关系边同理：`projection.ts` 的 `hiddenNodeIds` 会剔除任一端 unspawned 的边，`adjustRelation npc-caocao` 在玩家=曹操时被引擎按 lifecycle 判活忽略，**不会凭空造出一个自己**。
2. **叙事层**：以某人为第三视角叙述的池事件加 `{ flag: origin, ne: ... }` 排除，改由该身份的专属链用第二人称讲同一件事 —— `ev-zifen`（刘备）、`ev-lv-boshe`（曹操）、`ev-wujiaosha`（袁绍）、`ev-canteen`（曹操台词）；`ev-tangdong-open` 旁白去指名。
3. **后果层**：隐藏结局的五个 `fork*` flag 不能因排除池事件而断路，每条线都补了来源 —— `forkSuicide` ← `opt-liu-withdraw`、`forkBlameEra` ← `opt-cao-blame-era`、`forkShark` ← `opt-yuan-shark` / `opt-shark-camp`、`forkMeal` ← `opt-cao-kitchen` / `opt-yuan-feast`，`forkEmperor` 仍由 `ev-yuxi` 提供。

### 8.3 验证（第二轮，全部本地）

| 项目 | 结果 |
|---|---|
| 隔离根加载期校验 | **PASS** `LOAD OK`，1 套模板 / **25 事件** / 14 角色 / 7 技能 / 5 结局，指纹 `sha256:d5429b49…` |
| 默认根两套共存 | **PASS**，`jjk-2006` 指纹仍 `sha256:d8d81863…`、目录零改动 |
| `pnpm typecheck` / shared / game-core / web build | **PASS** / **67/67** / **478/478**（含 6 种子整局回归）/ `index-DLvGHcIx.js` 357.10 kB 与 R27 一致 |
| **7 种身份整局冒烟**（`playtest-identities.mjs`） | **7/7 OK**：seed 探测 `1/2/3/4/7/8/15` 覆盖全部 7 格；每局都走完专属链、触发 `ev-tianyi-anchor-1` + `ev-ch2-gate`、`chapter=2`、结局按身份分化 |
| 防分身明细（`npc-check.mjs`） | **PASS**：刘备局 `npc-liubei=ABSENT` 其余 alive（NPC 9）；曹操局 `npc-caocao=ABSENT`；袁绍局 `npc-yuan-shao=ABSENT`；虚构身份三人全 alive（NPC 10）。年龄改写生效 29 / 35 / 40，虚构身份 20，乌角鲨性别 `乌角鲨` |
| 云冒烟 / CI / UI 选择器 | **未跑**（判据针对 jjk、需 push、路线 A 明确不改前端），不写 PASS |

### 8.4 变更代价与边界

- **玩法结构变更**：仅新增/改写 `sanguo-2010` 目录内的 5 个 yaml（world / characters / opening / events / endings），新增 13 个剧情事件、3 条 spawn 规则、3 个身份结局；**引擎、契约面、前端、`jjk-2006` 全部零改动**。
- **存档代价**：`sanguo-2010` 指纹 `e38990a4…` → `d5429b49…` ⇒ **本模板第二轮前的旧存档全部拒载**（§4 已实证同一机制）；`jjk-2006` 旧档不受影响。
- **限制**：玩家显示名不会变成历史人物（§6）；三条人物线仍只覆盖第一章；隐藏结局数值门槛仍偏高。
- 未 push、未部署、未下线；`docs/RECOVERY_MERGE.md §6.3` 红线继续有效。
