# 三国演义梗模板 · 讨董一章小样验收报告

> **状态**：草案小样 / 路线 A / T-1 纯 yaml。分支 `feat/sanguo-meme-template`，基点 `5249163`。
> **范围**：只新增一个独立模板目录 `specs/data/templates/sanguo-2010/`；**未改任何既有模板、源码、schema、Spec、ADR，未建迭代四件套，未碰线上**。
> 玩法结构变更：新增独立世界模板（新 id / 新开局 / 事件 / 技能 / 道具 / 补正 / 结局），不改既有引擎行为。
> 存档代价：`jjk-2006` 目录零改动、指纹按目录独立 ⇒ **旧存档不受影响**；但 `sanguo-2010` 目录内任一 yaml 变化会让**本模板**旧档全部拒载（§4 已实证）。
> **2026-11-14 第二轮（§8）**：补上剧本层 —— 7 种身份（含刘备 / 曹操 / 袁绍三条真实人物线）、13 个剧情事件、3 个身份结局，以及用 `npcSpawnRules` 实现的「摇到真人就不刷分身」。主线锚点原样未动。yaml 由 1019 行增至 1604 行，指纹 `e38990a4…` → `d5429b49…` ⇒ **本模板第二轮前的旧存档全部拒载**（`jjk-2006` 旧档仍不受影响）。
> **2026-11-14 第三轮（§9）**：战争沙盘副本（剧情开启 flag → 条件行动博弈 → 主将对垒 → 收兵恢复）+ 年号 `初平`。yaml 增至 1898 行 / 32 事件 / 15 角色，指纹 `d5429b49…` → `34f08bca…` ⇒ **本模板第三轮前的旧存档全部拒载**。`era` 是引擎 R2.6 既有能力，本轮只用 T-1 yaml 接上；显示层「不同地区不同年号」属 T-2（需 ADR），**本轮未做、未裁决**。
> **2026-11-14 第四轮（§10）**：修「随机时间」三症状（32 天黑洞 / 事件乱序重复 / 人物关系空白）+ 写第二章剧本（徐州 → 官渡）+ 剧情层改元 + 关系图谱落地。yaml 增至 2565 行 / **44 事件 / 9 结局**，指纹 `34f08bca…` → `7db49ecf…` ⇒ **本模板第四轮前的旧存档全部拒载**。`era` 显示层多地区切换仍是 T-2 未做；改元本轮做在**剧情层**（`eraDraft` / `eraName` flag），未动契约面、未写 ADR。
> **2026-11-14 第五轮（§11）**：按身份重写事件（7 条身份链各 3 段：前情 / 处境 / 同人 if 分岔）、第 1~7 天公共日程改按**演义内因果顺序**（矫诏会盟 → 汜水关 → 虎牢关 → 军议 → 焚洛阳 → 传国玉玺 → 联盟离散）、公共事件按身份给条件选项（玉玺对非袁绍只有单选项、玩家选项零「称帝」）、清除全部集数 / 出处标注、把玩家可见文案对齐日历。yaml 增至 **3168 行 / 52 事件 / 9 结局**，指纹 `7db49ecf…` → `2622c0b4…` ⇒ **本模板第五轮前的旧存档全部拒载**。7 身份整条时间线 **7/7**、if 分支 **7/7**、fork 全覆盖、时间单调全绿；主线锚点 1/2、ch2-gate、战争沙盘结构原样未动。
> **2026-11-14 第六轮（§12）**：人物死亡实装（纯 yaml 接线，引擎零改动）。开局吕伯奢已故 / 汜水关五人同日阵亡 / 沙盘注销旗后面的人 / 「立军令状＋战败」才触发玩家战死路径；`npcState` 名册回响、关系边单向冻结、前端灰化标注 reasonCode。yaml 增至 **3451 行 / 53 事件 / 20 角色 / 13 结局**，指纹 `2622c0b4…` → `f0be54da…` ⇒ **本模板第六轮前的旧存档全部拒载**。死亡不推进时间：锚点 1/2、ch3、终止时间逐分钟与第五轮一致。7 身份死亡矩阵 **7/7**、战死路径 **4/4**、第五轮回归与战争矩阵全绿。
> **2026-11-14 第七轮（§13）**：剧情体验模拟打磨 + **第二个开局「200 · 建安五年衣带诏」**（7 格身份转盘、7 段按演义因果顺序的公共剧情、按身份结局）+ 初平元年两个天意折叠入口（第 7 天「提前放映」、第 59 天第三章接口）。yaml 增至 **4910 行 / 81 事件 / 28 角色 / 19 结局 / 2 开局**。时间纪律：衣带诏块全 `chain`、逐段 1 天、不 `advanceTo`，`worldTime` 全程单调；建安五年是**剧情层年号**，显示层仍是 T-2 未做的全局「初平 N年」。验证：新开局 **7/7**、折叠 **6/6**、陈留回归全绿、stall 兜底通过、typecheck / shared 67 / game-core 478 / web build 全绿。**按用户 2026-11-14 说明，本轮起不再记录存档拒载口径。**
> **2026-11-14 第八轮（§14）**：用户点出「190 副本 seed 3101 曹操的衣带诏剧情没做」「徐州让城成了公共事件」，总判断是「还是没把人物剧情做好」。实测坐实：折叠局跳过整条 `ev-ydz-line-cao-1/2`，`ev-ch2-1` 对 7 身份一律「印绶推到你面前」。修法从**选项级**分线升到**事件级**分线：徐州拆 4 条身份分支（刘备才让城）、过渡局按 `origin` 接进建安五年人物链（刘/曹/乌角鲨复用新开局链，袁绍/虚构组各写一条）、公共 7 段曹操改成当事人视角、过渡局新增 3 个按身份结局。yaml 增至 **5122 行 / 87 事件 / 22 结局 / 2 开局**。主线时间账逐分钟不变；折叠局多 1~2 天且单调。

---

## 1. 交付内容

| 文件 | 行数（第七轮后） | 内容 |
|---|---|---|
| `world.yaml` | 186 | meta（**双开局描述**）/ 年号 `era: 初平`（gregorian，**全局静态**）/ 性别枚举（含「乌角鲨」）/ 心情 / 状态栏 / 6 维属性（含 `tianyi`）/ 资源 / 4 个玩家行动 + 副本条件行动说明 / **11 条 `npcSpawnRules`**（陈留 3 + 建安 8，防分身）/ 第五轮时间线 + 第六轮死亡纪律 + **第七轮双开局与时间口径** |
| `characters.yaml` | 555 | **28 个角色**：原 20（13 NPC + 2 敌人 + `playerTemplate` + 4 汜水关将校 + 旗后面的人）+ **8 名建安人物**（董承 / 王子服 / 献帝 / 吉平 / 马腾 / 种辑 / 吴子兰 / 秦庆童）；吕伯奢开局 `inactive`，吉平在 `ev-ydz-exposed` 每个选项里 `inactive` |
| `skills.yaml` | 96 | 7 个技能：基础攻击 + 破军（大宝）/ 伏骑（麹义）/ 虚猲（邢道荣）/ 引兵（祖茂）/ 铁骑（界马超）/ 立牧（刘焉） |
| `items.yaml` | 38 | 陈留大食堂馒头、传国玉玺、乌角鲨幼体 |
| `statuses.yaml` | 60 | 天意侵蚀·精神错乱、集体失焦、天意护体、乌角鲨之威、三国 ELO·胜兵必骄 |
| `events.yaml` | 3549 | **81 事件**：陈留 53 条原样主干 + **打磨新增 4 条**（`ev-war-timeout` / `ev-road-eve` / `ev-ch2-eve` 等） + **28 条 `ev-ydz-*`**（折叠入口 2 + 新开局引导 1 + 转盘 1 + 7×2 身份链 + 公共剧情 7） |
| `opening.yaml` | 102 | **2 个开局**：`op-190-chenliu`（默认，`saga: 190`）/ `op-200-yidaizhao`（`saga: 200` / `chapter: 200` / `eraName: 建安五年`） |
| `endings.yaml` | 324 | **4 个终止条件**（陈留第 60 天 `saga eq 190` / 衣带诏 `ydzDone` / 衣带诏 120 天兜底 / playerRequested）+ `deathRoute` + **19 个结局**（原 13 + 衣带诏 6：过渡 / 董承 / 刘备 / 曹操 / 乌角鲨 / 通用） |
| **合计** | **4910** | 8 个 yaml（1019 → 1604 → 1898 → 2565 → 3168 → 3451 → **4910**） |

**省略的可选分域**：`equipment.yaml` / `combat-ai.yaml` / `evaluation.yaml`。加载器按文件存在性合并（`templates.ts:25-34, 50-68`），缺文件不报错，已实测通过。第三轮新增了 `kind: combat` 事件，但**未配 `combat-ai.yaml`**：未映射的敌人走既有简单权重路径，实测可正常打完（§9.3）；装备分域同样不需要。

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
> **第三轮更新**：战争沙盘 + 年号 yaml 变更后服务再次重启，当前加载的是 `34f08bca…` 版本（时间显示「初平 1年…」，第 42 天进战争沙盘）。启动命令与端口不变；试玩目录里 3 个第三轮前的存档全部按 `template_fingerprint_mismatch` 拒载（启动日志 `loaded:0 skipped:3`），`GET /api/worlds` → `{"worlds":[]}`，**新建一局即可**；3 个文件原样保留、未移动未删除。验证用的是**另一个独立服务**（3917 / `data-war`），不污染试玩列表。
> **第四轮更新（当前）**：随机时间修复 + 第二章剧本 yaml 变更后服务再次重启，当前加载的是 `7db49ecf…` 版本（44 事件 / 9 结局；第 1~7 天梗日程、第 8 天锚点后接路上 5 段、第 58 天第二次天意锚点）。启动命令与端口不变；试玩目录里 3 个第四轮前的存档同样按 `template_fingerprint_mismatch` 拒载（启动日志 `loaded:0 skipped:3`，`GET /api/worlds` → `{"worlds":[]}`），**新建一局即可**，3 个文件原样保留、未移动未删除。第四轮验证用的是**另一个独立服务**（3917 / `data-timeline`），不污染试玩列表。

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

---

## 9. 第三轮 · 战争沙盘副本与年号（2026-11-14）

用户两问：① 现有机制能否做「副本」（剧情开启世界 flag + 条件行动 + 战斗 + 剧情结束），做一场**战争沙盘**：开打后战斗是主将对垒、自由行动按条件切成战争行动、事件就是博弈、结束恢复日常；② 时间能否用年号（引擎本就按此设计），顺手做年号适配器，三国可做不同地区不同年号。

### 9.1 能力核验：能做，但「条件行动」要换个形态

| 用户要件 | 引擎现状 | 本轮做法（T-1 纯 yaml） |
|---|---|---|
| 剧情开启（世界 flag） | `setFlag` + `source: schedule`，建世界时按 `window.start` 一次性入队 | `ev-war-outbreak`：第 42 天 / `chapter=2` / `once` / `priority 90`，写入 `warActive / warPhase / warEdge / warRegion` |
| **条件行动** | ⚠️ `actions` schema **没有 conditions**，`projection.ts:256` 的 `availableActions` 恒定全量下发 ⇒ **按钮 label / 可见性无法随 flag 变** | 每个 `onActionId` 配一条 `action-hook`（`conditions: warActive eq true`），战争期点同一行动**额外弹出博弈事件**；选项用 `visibleWhen` 按 `warPhase` 分流。按钮本身仍是「点兵/开席/问策/歇息」 |
| 战斗（主将对垒） | `kind: combat` + `enemies` / `onVictory|onDefeat|onFlee.nextEventId` | `ev-war-duel`，敌人 `enemy-xiliang-commander`（旗号，不是再造一个华雄） |
| 事件就是博弈 | `normal` + `visibleWhen` + `adjustFlag warEdge` + 属性/资源加成 | 4 条博弈：阵列 / 离间 / 粮道 / 移营，布阵期给统御·智略·HP·MP 并推到接战期，接战期「叫阵」开战 |
| 结束恢复日常 | `clearFlag` ⇒ 条件失效 | `ev-war-close` 清 4 个 flag；`engine.ts:209` 缺失 flag 条件恒 false ⇒ hook 自动静默 |

约束已核对：同一 `onActionId` 至多一条「立即」hook（`world.ts:427`），本轮每个行动恰好一条；`turn.ts:576` 非链事件 `nextEventId` 直接 `triggerEventV2`，所以叫阵选项能直接建战斗会话。

### 9.2 实测闭环（seed 42，`smoke-war.mjs`）

```
初平 1年2月11日  ev-ch2-gate（第 41 天，主线原样）
初平 1年2月12日  ev-war-outbreak → opt-war-accept（warActive=true / warPhase=1）
初平 1年2月13日  turn consult → ev-war-counsel（博弈）→ opt-war-send-all（warPhase=2）
初平 1年2月14日  turn rest    → ev-war-rest（博弈）→ opt-war-challenge-rest（叫阵）
                  ev-war-duel：15 个战斗回合（sk-basic-strike）→ onVictory
                  ev-war-close → opt-war-return（clearFlag ×4，天意把三份战报抄回初平）
初平 1年2月15/16/17 日  turn rest ×3 → hooks = 0（日常行动已恢复）
```

主线锚点（第 8 天 `ev-tianyi-anchor-1`、第 41 天 `ev-ch2-gate`）一字未改；副本不写 `chapter`、不 `advanceTo`、不改结局判据。

### 9.3 验证结果

| 项目 | 结果 |
|---|---|
| 隔离根 `TEMPLATES_DIR` 加载 | **PASS** `LOAD OK`，1 套 / **32 事件 / 15 角色 / 7 技能 / 5 结局**，指纹 `sha256:34f08bca…` |
| 默认根两套共存 | **PASS**，`jjk-2006` 目录零改动、指纹仍 `sha256:d8d81863…` |
| typecheck / shared / game-core / web build | **PASS** / 67/67 / 478/478（含 6 种子整局回归）/ `index-DLvGHcIx.js` 357.10 kB 与 R27 一致 |
| `smoke-war.mjs`（整局闭环） | **PASS**：年号显示「初平 1年1月1日」、开战、博弈、对垒 15 回合、收兵、收兵后 3 次行动零 hook、`chapter=2` |
| `smoke-war-matrix.mjs`（5 例） | **5/5 OK**：`drill/consult/feast/rest` 四条 hook 各命中一次（seed 11–14，14 回合结束），seed 15 走 `flee` 撤离（1 次命令）→ `onFlee` → 收兵；每例收兵后 2 次行动零 hook |
| 云冒烟 / CI / 真机点屏 / UI 模板选择器 | **未跑**，不写 PASS |

### 9.4 年号：引擎 R2.6 已有，本轮只接配置

- `CalendarConfigSchema.era` + `time.ts` 的 `createTimeAdapter` / `eraYearBase` / `format` **早已实现**（ADR-0002 / ADR-0013）：`gregorian` 与 `custom` 都支持 `era: { name, epochStartMinute }`，输出「`${name} ${eraYear}年…`」，负起点表示纪元早于世界起点。`approx` 走独立分支不支持。
- 三国模板原本 `calendar: { preset: gregorian }`，本轮加 `era: { name: 初平, epochStartMinute: 0 }`（公元 190 = 初平元年）⇒ 建局显示「**初平 1年1月1日 00:00**」，冒烟实证。**零源码改动，T-1**。
- 「不同地区不同年号」本轮做在**叙事层**：`warRegion` flag + 事件文案（袁术营「仲家」、江东「初平」、有人写「天意元年」），收兵时天意统一抄回正朔。显示层按阵营切换年号需要给 `CalendarConfigSchema` 加 `eras[]` / `eraRegionFlag`、给 `CalendarAdapter` 加接收 state 的格式化入口并改约 10 处调用点 ⇒ **T-2 契约面，按 `AGENTS.md §0.3` 必须先 ADR**；旧机两个大版本源码未找回、线上 `/api/templates` 已证实版本化契约，此刻改契约面风险过高。完整提案见 `docs/SANGUO_TEMPLATE_BRIEF.md §9.4`。**本轮未写 ADR、未动契约面、未作裁决。**
- 已知显示细节：引擎输出「初平 **1**年」而非「初平**元**年」，改 `format` 同样属 T-2。

### 9.5 变更代价与边界

- **玩法结构变更**：只改 `sanguo-2010` 目录内 3 个 yaml（`world` 加 era + 注释、`characters` 加 1 个主将敌人、`events` 加 7 个副本事件）。新增一段**第 42 天起可进可出的战争副本**，主线触发拓扑、结局判据、引擎、契约面、前端、`jjk-2006` 全部零改动。
- **存档代价**：本模板指纹 `d5429b49…` → `34f08bca…` ⇒ **第三轮前的本模板旧存档全部拒载**（ADR-0007 既定策略，§4/§7 已实证）；`jjk-2006` 旧档不受影响。
- **限制**：按钮文案不会随战争状态变（条件行动是 hook + `visibleWhen` 的等价形态，非真·按钮切换）；敌人未配 `combat-ai.yaml`，走既有简单权重路径（实测可打完）；战争副本只覆盖第 42 天之后一段，仍是一章内的支线；前端 `templates[0]` 写死、界面仍不可选模板。
- 未 push、未部署、未下线；`docs/RECOVERY_MERGE.md §6.3` 红线继续有效。

---

## 10. 第四轮 · 改元状态、随机时间修复与第二章剧本（2026-11-14）

本轮四问：①「改元做了嘛」；②「写下后面的剧本」；③「修随机时间：完全看不出主角参与」；④「事件也是乱的、人物关系也没做」。结论：**改元显示层没做（T-2），剧情层这轮补上；后三问全部落地为纯 yaml**。

### 10.1 改元的准确状态（先回答问题）

| 事项 | 状态 | 说明 |
|---|---|---|
| 全局正朔年号「初平」 | ✅ 第三轮已做 | `world.yaml` 的 `calendar.era: { name: 初平, epochStartMinute: 0 }`，建局显示「初平 1年1月1日 00:00」。引擎 R2.6 既有能力，T-1 纯 yaml |
| 「改元」作为**剧情** | ✅ 本轮补上 | `ev-road-3` 用 `eraDraft` 让玩家先在账册上选（初平 / 仲家 / 天意 / 未定）；`ev-ch2-2`「改元 · 三本账册」用 `eraName` 正式落笔；第 58 天锚点 2 由天意拨回「初平」，但 `eraDraft` 不清除 ⇒ 后果不撤销，只改写认知 |
| **按地区 / 阵营切换年号显示** | ❌ **没做** | `era` 是单个静态全局字符串，`CalendarAdapter.format(minutes)` 是纯函数拿不到 `state.flags`。要做得扩 `CalendarConfigSchema`（`eras[]` / `eraRegionFlag`）+ `CalendarAdapter` + 约 10 处 `format` 调用点 ⇒ **T-2 契约面，按 `AGENTS.md §0.3` 必须先写 ADR**；且旧机两个大版本源码未找回、线上 `/api/templates` 已证实版本化契约，此刻改会正面撞车。最小改法见 `docs/SANGUO_TEMPLATE_BRIEF.md §9.4` |
| 「初平 **1**年」改「初平**元**年」 | ❌ 没做 | 需要改 `time.ts` 的 `format`，同属 T-2 |

**本轮未写 ADR、未动契约面、未作裁决、未擅自推进 T-2。** 剧情层改元只是 flag + 叙事，显示层仍恒为「初平 N年」。

### 10.2 「随机时间」三症状的根因（以代码为准）

| 症状 | 根因 | 修法 |
|---|---|---|
| **完全看不出主角参与** | 第 8 天锚点 `advanceTo` 直接跳到**第 40 天**，中间 32 天没有任何事件（池事件 `chapter=1`，锚点已改成 2）；第 42 天战争收兵后同样空转。主角在场，世界零反应 | 锚点 `advanceTo` 40 → **20**（只折起 12 天），并用 chain 出口接 5 段「路上」剧情（`timeCost` 4+4+4+4+5 = 21 天）正好走到第 41 天 ch2-gate；收兵再接 5 段第二章剧情。整条时间线无空白段，最大连续无事件行动 **3** 次 |
| **事件也是乱的** | 7 条梗原是 `source: pool` 加权随机抽一：`priority` 在 `pickWeighted` 里**不影响抽样**；且「抽中先入队、后触发」会让同一条事件在 fire 前被重复入队，`once: true` 只认已触发事实 ⇒ 实测 **10 次触发只有 6 条不同**，第 36 集「自刎归天」还可能出现在讨董之前 | 全部改成 `source: schedule` + `window.start`，第 1~7 天各一条，**按原剧集数排序**（吕伯奢 2/3 集 → 大食堂 5 → 玉玺 6 → 乌角鲨 11 → 三国杀插曲 5/6 → 自刎归天 36 最后放）；`window.end` 统一第 8 天，被 `origin` 排除或错过的实例静默过期。随机性保留在**开局 7 格转盘与分歧选项** |
| **人物关系也没做** | `characters.yaml` 头注释原本明写「本小样不写边」，只有 4 条 NPC→玩家标量；但引擎 **ADR-0014 关系图谱完整可用** | `characters.yaml` 铺 25 条 `relations` 边（亲属边方向逐条对照「`to` 是 `from` 的 kind」，其余用社会边）；剧情用 `addRelationEdge` 建可见边、关系边形态 `adjustRelation` 做增量，`visibleWhen` 用 `{ relation, kind, to, gte }` 边条件分岔。前端人物面板会渲染「X视Y为…」 |

`once: true` 在本轮**先加过一轮并实测无效**（`check-once.mts` 证实加载值确实是 `true`，但 `eventFires` 仍出现 `ev-daorong` ×3），根因是入队积压，不是配置写错 ⇒ 才改成日程。这是本轮最值钱的一次证伪。

### 10.3 第二章剧本（徐州 → 官渡，主线不变）

从 `ev-war-close` 收兵接 chain，5 段各 `timeCost: 2 day`：

| 事件 | 内容 | 人物线 |
|---|---|---|
| `ev-ch2-1` 徐州 · 让城 | 陶谦病重、印绶推到面前，城外的人只问「城门今天开不开」 | 刘备「先安置名册上的人」/ 曹操「先点仓」/ 袁绍「先问谁举荐的」 |
| `ev-ch2-2` 改元 · 三本账册 | 寿春「仲家」、江东「初平」、有人写「天意元年」，玩家写第四本 | **剧情层改元**；`visibleWhen` 按 `eraDraft=天意` 或 `origin=刘备` 开专属选项 |
| `ev-ch2-3` 兖州 · 空营 | 灶还温着、名册最后几行是空的。承接第一章 `forkBlameEra` | 曹操「这次不交给世道，认下来」；`{ relation: npc-xun-yu, kind: colleague, to: player, gte: 10 }` 开「让荀彧重造册」 |
| `ev-ch2-4` 河北 · 再等等 | 田丰许攸各递一封，出口又是「诸位以为如何」 | 袁绍专属；`{ relation: npc-yuan-shu, kind: elder-brother, to: npc-yuan-shao, gte: 32 }` 开「让袁术先签」 |
| `ev-ch2-5` 官渡前夜 · 三本账 | 三方国道口扎营，四本账册叠成一摞 | 三条线各自收束，`setFlag ch2Done=true` |

**第 58 天 `ev-tianyi-anchor-2`**（schedule + once + priority 100，与第一章同机制）：`chapter=3` / `mainline=官渡` / `eraName=初平` / 认知改写，**不回滚任何后果**；conditions 含 `ch2Done`，玩家没走完就 hold 留队、不记错失 ⇒ 天意仍然「一定会发力」。第 59 天 `ev-ch3-gate` 只留一句预告，第 60 天 `timeReached` 终止。

主线纪律：第 8 天锚点 1、第 41 天 ch2-gate、第 42 天战争沙盘**原样未动**；锚点 1 只改了跳跃距离并加 chain 出口，`chapter` / `anchor1Done` / `mainline` 效果一字未改。三条人物线仍汇入同一条主线，梗只作场景台词。

### 10.4 验证结论

- **整条时间线冒烟**（`D:\code\_sanguo_isolated\smoke-full-timeline.mjs`，7 身份矩阵 **7/7 OK**）：第 1~8 天 → 路上 5 段严格有序 → ch2-gate → 战争沙盘（15~16 回合主将对垒）→ 第二章 5 段严格有序 → 锚点 2 → 第三章接口 → 第二章结局。
- 日程化后池事件 **7 次触发 7 条不同**（虚构身份；真实人物按 `origin` 排除 1~2 条 ⇒ 5~6 条，符合防分身设计），**零重复**。
- **关系边上屏**：投影可见关系边 29~44 条（按身份不同，玩家占用的 NPC 边随 `unspawned` 被剔除）；`tianyi` 终值 6~12，隐藏结局未变成必得。
- **结局按身份分化**：虚构身份 `end-guandu`，刘备/曹操/袁绍分别 `end-guandu-liubei/-caocao/-yuanshao`；防分身断言 3/3 通过。
- 隔离根 `LOAD OK`（44 事件 / 15 角色 / 9 结局）、默认根两套共存、`jjk-2006` 目录零改动且指纹 `d8d81863…` 未变；typecheck **PASS** / shared **67/67** / game-core **478/478** / web build `index-DLvGHcIx.js`（357.10 kB，与 R27 一致）。
- **未跑**：云冒烟（判据针对 jjk）、CI、真机点屏、UI 模板选择器。

### 10.5 变更代价与边界

- **玩法结构变更**：仅 `sanguo-2010` 目录内 `world` / `characters` / `events` / `endings` 四个 yaml。新增「第 1~7 天梗日程」「路上 5 段」「第二章 5 段」「锚点 2」「第三章接口」与 4 个第二章结局；**引擎、schema、契约面、前端、`jjk-2006` 全部零改动**，未建迭代四件套、未写 ADR、未作产品裁决。
- **存档代价**：本模板指纹 `34f08bca…` → `7db49ecf…` ⇒ **第四轮前的本模板旧存档全部拒载**（ADR-0007 既定策略，启动期 `template_fingerprint_mismatch`）；`jjk-2006` 旧档不受影响。
- **限制**：年号显示仍是全局静态「初平 N年」，剧情层改元不会改变时间栏；第 54→58 天有约 3~4 次常规行动期（等锚点 2 到点，非空白黑洞）；第二章仍只到「官渡前夜」，第三章仅一句接口；前端 `templates[0]` 写死、界面不可选模板。
- 未 push、未部署、未下线；`docs/RECOVERY_MERGE.md §6.3` 红线继续有效。

---

## 11. 第五轮 · 按身份重写事件 / 演义时间轴（2026-11-14）

用户五条：① 按身份重写事件、每个身份都有自己的故事；② 主线先把三名原著人物在演义里的事件**按时间捋一遍**，再写同人 if 分支，再写虚构身份；③ 随机 / 公共事件按主角身份写（「不然谁都可以称帝了」）；④ 公共事件用条件选项，完全没参与的只有一个选项（举了传国玉玺）；⑤ 不写梗的出处、不按原作集数排时间，**最重要是时间别出问题**。

### 11.1 先按演义时间捋三人

完整三人对表与逐梗时点见 `docs/SANGUO_TEMPLATE_BRIEF.md §11.1`（本轮联网核对演义回目顺序 + 初平元 / 二年纪年）：

| 时点 | 刘备 | 曹操 | 袁绍 |
|---|---|---|---|
| 189 冬 | 依公孙瓒 | 寿宴喊话 → 献刀刺董 → 误杀吕伯奢 → 陈留募兵 | 诛宦竖 → 反对废立 → 出奔渤海 |
| 190 正月 | 随公孙瓒赴会、末席；温酒斩华雄、三英战吕布 | 发矫诏、集诸侯 | 被推盟主、定座次 |
| 190 二月 | 随军北回 | 独追董卓、荥阳败归 | 按兵不动、联盟离散、质问孙坚 |
| 191→200 | 平原相 / 三让徐州 / 依曹 / 煮酒 / 投袁绍 | 都许 / 讨袁术 / 煮酒 / 官渡 | 冀州牧 / 磐河 / 官渡 |
| 208 | 携民渡江 | — | — |

⇒ 第四轮「按剧集数排序」把 208 年的「自刎归天」塞进第 7 天、把 189 年的吕伯奢当成陈留军议，正是时间乱的根源。本轮：**前期梗放身份链前情段（不占世界天数）**；**194 / 208 的后期梗集中到第 7 天，明写「天意提前放映」**，绝不伪装成初平元年正月发生的事。模板 8 个 yaml 内集数 / 出处字样 Grep **0 命中**，考据全部留在 brief 文档。

### 11.2 事件结构：52 事件 / 7 条身份链

| 段落 | 事件数 | 机制 |
|---|---|---|
| 开局转盘 | 2 | `chain` + `kind: random` 7 格，防分身 `spawnNpc` 原样 |
| **7 条身份链** | **21** | 各 3 段 `chain`：前情 → 处境 → **同人 if 分岔**（`ifLiu` / `ifCao` / `ifYuan` / `ifLord` / `ifAdvisor` / `ifSoldier` / `ifShark`） |
| 讨董大会 | 1 | 公共 `chain`，按 `origin` 给条件选项 |
| **第 1~7 天公共日程** | **7** | `source: schedule`，按演义因果顺序，人人触发 |
| 锚点 1 / ch2-gate | 2 | `schedule` 第 8 / 41 天，原样 |
| 战争沙盘 | 7 | 第 42 天，4 条 action-hook + 对垒 + 收兵，**整块原样保留** |
| 路上 5 段 / 第二章 5 段 | 10 | `chain` + `timeCost`，每段按身份分岔 + if 回响 |
| 锚点 2 / ch3-gate | 2 | `schedule` 第 58 / 59 天，原样 |

新日程顺序：矫诏会盟 → 汜水关 → 虎牢关 → 陈留大食堂 → 焚洛阳 → **传国玉玺** → 联盟离散（天意提前放映）→ 第 8 天锚点。

### 11.3 公共事件按身份写（「谁都不能称帝」）

- **三层写法**：1 个无 `visibleWhen` 的兜底选项（人人可见，并补齐 `fork*` flag）＋若干 `visibleWhen: origin eq X` 专属选项＋`origin ne 三人组` 的虚构身份共用选项 ⇒ 完全没参与的身份只有一个选项。
- **传国玉玺**（用户点名的样本）：「恭喜爹可以称帝了」只是孙策对孙坚说的台词，写在 `narrative`；玩家选项只有「看着那块石头被捧过去」，仅 `origin=袁绍` 多一个「当众质问孙坚」。实测 **非袁绍 1 个选项 / 袁绍 2 个**，7 身份全程玩家选项含「称帝」**0 条**。
- **第 4 天大食堂**：只有曹操能发起挽留、虚构身份能试图拉回正题；刘备 / 袁绍只有 1 个旁观选项（实测 1）。
- **fork 兜底**：`check-forks.py` 静态核对第 4 / 6 / 7 天每个选项都设齐对应 flag（1/1、1/1、3/3），五条 `fork*` 全局来源数 4 / 2 / 5 / 5 / 5 ⇒ 隐藏结局不因身份变死路。

### 11.4 时间（本轮最看重）

- 7 条公共日程实测 pending 顺序 **1→7 严格有序、零重复**；7 身份链只出现自己的 3 段（`other lines = 0`）。
- `worldTime` 全程**单调非递减**；锚点 1 恒在 **11520**（正月初九）、锚点 2 恒在 **83520**（二月二十八）、ch3 恒在 **84960**（三月初一）、终止恒在 **初平 1年3月2日**；最大连续无事件行动 **3** 次。
- **日历口径**（`docs/SANGUO_TEMPLATE_BRIEF.md §11.2`）：世界起点 `1月1日 00:00` = `worldTime 0`，`window.start: N day` 对应正月初 N+1。注释里的「第 N 天」是 `worldTime` 口径（给开发者），**玩家可见文案一律改成日历日期或「天意发力那天」**（锚点 1 正月初九 / 战争 二月十二 / 锚点 2 二月二十八；开局与结局描述同步）。
- 主线纪律不变：锚点 1/2 仍 `schedule + once + priority 100`，`advanceTo 20` 与路上 5 段 `4+4+4+4+5=21` 天正好接第 41 天 ch2-gate；战争沙盘不写 `chapter`、不 `advanceTo`。

### 11.5 验证矩阵（本机 3917 独立服务 / 仓库外数据目录）

| 项 | 结果 |
|---|---|
| 整条时间线 7 身份矩阵（`rebuild/smoke-v5.mjs`，seed 1/2/3/4/7/8/15） | **7/7 OK**：身份链、日程顺序、玉玺单选项、零称帝选项、时间单调、锚点 1/2、ch2/ch3-gate、战争开合、路上与第二章有序、按身份结局、防分身 3/3、关系边 29~44 |
| if 分支 7 身份（`rebuild/smoke-if.mjs`） | **7/7 OK**：每条 if 都能选中并在路上 / 第二章看到回响选项，主线时间不变、结局仍按身份分化 |
| fork 覆盖（`rebuild/check-forks.py`） | **OK**：公共事件每个选项补齐，五条 flag 均有来源 |
| 集数 / 出处残留 | **0**（8 个 yaml 全目录 Grep） |
| 加载期 | 默认根 2 套 `LOAD OK`（`jjk-2006` 指纹 `d8d81863…` 未变）；隔离根 1 套 `LOAD OK` |
| 全量测试 | typecheck **PASS** / shared **67/67** / game-core **478/478** / web build `index-DLvGHcIx.js`（357.10 kB） |
| 隐藏结局 | `tianyi` 终值 −1~6，未变成必得（阈值仍需五条 fork 全齐 + ≥60） |

### 11.6 变更代价与边界

- **玩法结构变更**：仅 `sanguo-2010` 目录内 8 个 yaml 与 2 份文档；7 条身份链、按演义顺序重排公共日程、公共事件条件选项与单选项、if 线、集数清零、日历口径对齐。**引擎、schema、契约面、前端、`jjk-2006` 零改动**，未建迭代四件套、未写 ADR、未作产品裁决。
- **存档代价**：本模板指纹 `7db49ecf…` → **`2622c0b4…`** ⇒ 第五轮前的本模板旧存档全部拒载（ADR-0007 既定策略，启动期 `template_fingerprint_mismatch`），文件原样保留、未移动未删除；`jjk-2006` 旧档不受影响。
- **限制**：年号显示仍是全局静态「初平 N年」；第二章仍只到官渡前夜、第三章仅一句接口；前端 `templates[0]` 写死、界面不可选模板；第 54→58 天仍有约 3 次常规行动期（等锚点 2，非空白黑洞）。T-2「按地区切换年号显示」仍待用户拍板，建议等旧机源码找回。
- **未跑**：云冒烟（判据针对 jjk）、CI、真机点屏、UI 模板选择器。未 push、未部署线上、未下线；`docs/RECOVERY_MERGE.md §6.3` 红线继续有效。

---

## 12. 第六轮 · 人物死亡实装（2026-11-14）

### 12.1 结论：引擎机制现成，模板首次接线

先核查代码（而非假设）：`lifecycle` 三态、`setNpcLifecycle`、`npcState` 条件、关系边死亡冻结、`resolveCombatRefs` 参战判活、前端 NPC 卡片灰化 + `reasonCode` 显示、`deathRoute` 战败死亡路径（服务端 `templates.ts` 读 `endings.yaml` → `turn.ts` 战败边界）**全部已实现**，只是 `sanguo-2010` 一处都没用。本轮**零引擎改动**，只动 4 个 yaml 与 2 份文档。

### 12.2 死亡时间账（不占新天数、不改任何时间坐标）

| 时点 | 日历 / `worldTime` | 死亡对象 | 接线位置 |
|---|---|---|---|
| 建世界（189 冬前情，不占天数） | — | 吕伯奢 | `characters.yaml` 初始 `lifecycle: inactive / 成皋误杀` |
| 第 2 天 | 正月初三 / 2880 | 鲍忠、俞涉、潘凤、祖茂、华雄 | `ev-day2-sishui` **5 个选项各写一组** `setNpcLifecycle`（幂等、与玩家选择解耦） |
| 第 42 天 | 二月十二 / 60480 | 旗后面的人 | `ev-war-duel.onVictory` + `ev-war-close` 两条选项（同一 reasonCode「阵前旗倒」） |
| 第 42~44 天 | 二月十二~十四 | 玩家（可选） | 「立军令状 `vowNoRetreat`」+ 战败 `battleLost` ⇒ `endings.yaml` 的 `deathRoute` |

**时间零扰动**：没有新增 `schedule` 事件，没改 `window` / `timeCost` / `advanceTo` / `nextEventId`。7 身份实测锚点 1 恒 **11520**、锚点 2 恒 **83520**、ch3 恒 **84960**、终止恒 **初平 1年3月2日**，`worldTime` 全程单调，与第五轮逐分钟一致。模板内仍无集数 / 出处标注，死亡按演义因果顺序而非播出顺序。

### 12.3 三个实现要点

- **`isEnemy: true` 不建 NPC 实例**（`npc.ts:36`）：原 `npc-hua-xiong` 带此标签，直接写 `setNpcLifecycle` 会抛「指向未知 NPC」。改 `isEnemy: false` 让它有实例（它从来不是任何战斗 ref）；沙盘阵亡另用自造角色 `npc-flag-bearer`，**不对 `enemy-*` 写生命周期**。
- **`npcState` 做死后回响**：第 3 天 / 路上 1/5 / 第 7 天各加一个只在死者 `inactive` 时出现的名册选项；前两条故意对死者写 `adjustRelation -5` / `addRelationEdge`，实测被静默忽略（华雄关系恒 `-8`）。第 7 天新选项补齐三条 `fork*`，隐藏结局不变死路（fork 覆盖 OK）。
- **玩家死亡双 flag 门槛**：`deathRoute.conditions` 与 4 个 `end-hero-fall*` 的 `triggerConditions` 用同一组 `vowNoRetreat + battleLost`（都在死亡裁决前写入 flags），`deathMode: event` 复用 `ev-hero-fall`。普通战败（默认 7 身份 + 战争矩阵）照常收兵；立了誓没战败也不会误判死亡结局；不以 HP 为判据。战死结局按身份分线（通用 / 刘 / 曹 / 袁），priority 200 / 210 高于隐藏结局。

### 12.4 验证矩阵（本机 3917 独立服务 / 仓库外数据目录）

| 项 | 结果 |
|---|---|
| 死亡矩阵 7 身份（`rebuild/smoke-death.mjs`，seed 1/2/3/4/7/8/15） | **7/7 OK**：开局已故、汜水关五人同日阵亡且 reasonCode 逐一正确、整局仍为死者、旗后面的人注销、3 个 `npcState` 回响全上屏、纯敌人不上人物面板、关系写入被忽略、时间/锚点/结局/防分身全绿 |
| 玩家战死 4 身份（`rebuild/smoke-hero-death.mjs`） | **4/4 OK**：`end-hero-fall` / `-liubei` / `-caocao` / `-yuanshao` 按身份命中，`ending.source=battleDefeat`、reason 为「战败死亡事件结算后触发结局」，终止在 2月14日、未进第二章 |
| 关系边冻结（`rebuild/check-frozen.py`，33 局存档） | **OK**：每局 4 条 `frozen` 边（华雄↔董卓 ×2、俞涉↔袁术、祖茂↔孙坚），无一条两端皆生者 |
| 第五轮回归 | 整条时间线 **7/7**、if 分支 **7/7**、战争矩阵 **5/5**、fork 覆盖 **OK** |
| 加载期 | 默认根 2 套 `LOAD OK`（`jjk-2006` 指纹 `d8d81863…` 未变）；隔离根 1 套 `LOAD OK` |
| 全量测试 | typecheck **PASS** / shared **67/67** / game-core **478/478** / web build `index-DLvGHcIx.js`（357.10 kB） |

### 12.5 一处口径差异与代价

- **开局已故的吕伯奢没有 `frozen` 标记**：`freezeOnDeath` 只在运行期 `setNpcLifecycle` 时调用。但 `isAliveNode` 判活已挡住所有针对他的关系写入，行为等价，且模板不会让他复活 ⇒ 棘轮语义无差别。如实记录，不改引擎；若将来要初始态也带标记，属引擎改动、需另立 ADR。
- **存档代价**：指纹 `2622c0b4…` → **`f0be54da…`** ⇒ 第六轮前本模板旧档全部拒载（ADR-0007 启动期 `skipped`，文件原样保留、未删未移）；`jjk-2006` 旧档不受影响。
- **边界**：仅 `sanguo-2010` 的 4 个 yaml + 2 份文档；引擎 / schema / Spec / ADR / 前端 / `jjk-2006` 零改动。T-2 年号显示、第三章展开仍待拍板；未跑云冒烟 / CI / 真机点屏 / UI 模板选择器；未 push、未部署、未下线，`docs/RECOVERY_MERGE.md §6.3` 红线继续有效。

---

## 13. 第七轮 · 体验打磨 + 建安五年衣带诏新开局

### 13.1 先把剧情跑一遍：模拟体验暴露了什么

按 7 身份跑完整时间线逐条打点（事件序列 / 时间点 / 选项数 / 连续无事件行动 / 重复 / 时间单调），基线（第六轮，seed 1 谋士）：30 事件、单选项 7 个、`maxBlankRun 3`、沙盘 `ev-war-rest` 重复 1 次、最长空窗第 52→58 天与第 36→41 天。逐条定位后修：

| # | 问题 | 修法 |
|---|---|---|
| 1 | 锚点 1 把第 8 天直接拨到第 20 天，12 天无解释；日志还写成「三十二天折成十二天」 | narrative + log 统一为「往徐州路上的十二天折成一步，日历少十二页、东西一页没少」 |
| 2 | 沙盘 `ev-war-rest` 连弹两次同标题同叙事；phase2 只剩叫阵一条路 | 标题/叙事改中性；phase2 加「不叫阵，只把更鼓数完」；4 个 hook 各加一条「主动收兵」→ `ev-war-close` |
| 3 | **不叫阵 ⇒ 第二章整条 chain 永不开始**（`ev-ch2-1` 只挂在 `ev-war-close` 的 `nextEventId`） | 第 45 天 `ev-war-timeout`（`conditions: warActive eq true`）自动收兵兜底；stall 策略实测第 45 天收兵 → 第二章 → 锚点 2/3 → `end-guandu` |
| 4 | ch2-gate / ch3-gate 只有 1 个按钮 | ch2-gate 补 2 个（含死者名册回响），ch3-gate 补天意折叠选项；单选项 7 → **5** |
| 5 | 第 52→58 天连续 3 次无事件行动、第 36→41 天间隔 5 天 | 补 `ev-ch2-eve`（第 55 天）、`ev-road-eve`；`maxBlankRun 3 → 2`、事件 30 → **32** |

**一个实测坑**：`ev-road-5` 的 `timeCost: 5 day` 把 `worldTime` 从第 36 天一次跳到第 41 天，`window: 38~40 day` 的实例在 drain 时已被判 `window_expired` 静默过期 ⇒ 窗口改成 `36~42 day` 才真的在第 41 天触发（与 `ev-ch2-gate` 同日，排序在章节门之前）。固定日日程与 chain 大步长同用时必须这样核对。

打磨后：事件 **32**、单选项 **5**、`maxBlankRun 2`、第 41 天事件密度 1→2、`worldTime` 单调、终止仍 3月2日、结局仍 `end-guandu`。衣带诏新开局（seed 1 曹操）：10 个事件分布 0~8 天，**每天一件、零空窗、零重复**，单选项仅转盘启动 1 个。

### 13.2 建安五年衣带诏 · 第二个开局

- `opening.yaml` 新增 `op-200-yidaizhao`（`saga: 200` / `chapter: 200` / `eraName: 建安五年`），`handoff.pendingEvents: [ev-ydz-open]`。前端 `openings.length > 1` 自动渲染开局下拉，实测 `/api/templates` 返回两个开局；陈留仍是默认。
- **7 格命数转盘**：董承 / 刘备 / 曹操 / 王子服 + 送膳的小黄门 / 相府门客 / 一头乌角鲨；每格 2 段身份链（前情·处境 → 同人 if 分岔）。新增 8 名建安 NPC、8 条 `npcSpawnRules`，沿用「玩家是谁就不刷谁」⇒ 陈留局里他们全部 `unspawned` 不上屏。
- **公共剧情 7 段按演义因果顺序**：玉带血诏 → 义状七人（签名逐人写出）→ 青梅煮酒 → 截击袁术、马腾回凉 → 元旦吉平咬指、秦庆童告密 → 事发（吉平 `setNpcLifecycle inactive / 撞阶殉死`）→ 天意收束回官渡。模板内不写回目、不写播出序号。
- **公共事件仍按身份分流**：兜底选项人人可见，专属选项 `visibleWhen: origin eq X`；完全没参与的身份（如过渡局、门客）只有兜底一个选项。核心人物补了 8 条专属选项 ⇒ 曹操 / 董承全程只剩 1 个单选项（转盘启动）。
- **结局** 6 篇（过渡 / 董承 / 刘备 / 曹操 / 乌角鲨 / 通用），priority 50~70 高于陈留第一章（0/10）与第二章（20/25），低于隐藏结局（100，需五条 fork + tianyi≥60，衣带诏局拿不到）。

### 13.3 时间口径与两套剧情隔离（用户最看重的一条）

- 衣带诏块**全部 `source: chain`、逐段 `timeCost: 1 day`、零 `advanceTo`**，不把绝对年份写进时间坐标；新开局 0→8 天，两个折叠入口分别第 7 / 59 天进入再走 8 天，实测 `worldTime` 全程单调、无重复、无倒挂。
- **建安五年是剧情层年号**：`eraName` flag + 叙事「更漏已报建安五年，历书还停在初平元年这一格——天意改了人，没顾上改纸」。显示层仍是 `world.yaml` 全局静态「初平 N年」；按开局 / 地区切换年号属 T-2 契约面，**未授权、未动**。
- 隔离：`chapter: 200` 让陈留所有 `chapter=1/2/3` 的 schedule 事件 `hold`（带 `window.end` 的到期静默过期）；`saga` flag 让陈留第 60 天终止条件与衣带诏 `ydzDone` / 120 天兜底各管各的。
- 两个折叠入口：`ev-day7-dissolve` 的「顺着提前放映的那一页往下翻」（初平元年正月即可过去）、`ev-ch3-gate` 的「把十年折成一步」（主线走完接续），都 → `ev-ydz-fold` → `ev-ydz-arrival` → 与新开局在 `ev-ydz-edict` 汇合。过渡局**不重转转盘**、保留原 `origin`；第七轮在此只给「没参与」的兜底选项，第八轮（§14）已改为按 `origin` 接进建安五年人物链。

### 13.4 验证矩阵（本机 3917 独立服务 / 仓库外数据目录）

| 项 | 结果 |
|---|---|
| 体验模拟（`rebuild/experience.mjs`，含 `STRATEGY=stall`） | 陈留打磨后 32 事件 / 单选项 5 / maxBlankRun 2 / 单调；**不叫阵时第 45 天兜底收兵接回第二章** |
| 衣带诏新开局 7 身份（`rebuild/smoke-ydz.mjs`，seed 1/2/3/4/6/7/14） | **7/7 OK**：身份链只走自己那条、公共 7 段有序、无陈留泄漏、无分身、吉平 `inactive`、结局按身份、自然终止、时间 0→8 天单调 |
| 专属选项链出口（`STRATEGY=last`，3 身份） | **3/3 OK**：吉平之死与选项解耦（写进 `ev-ydz-exposed` 每个选项） |
| 天意折叠（`rebuild/smoke-fold.mjs`，day7 / ch3 × seed 1/3/4） | **6/6 OK**：折叠点恒第 7 / 59 天、折叠后无陈留事件、结局恒 `end-ydz-transition`、时间单调 |
| 陈留回归 | 整条时间线 **7/7**、死亡 **7/7**、if **7/7**、战争矩阵 **5/5**、玩家战死 **4/4**、fork 覆盖 **OK** |
| 静态检查（`rebuild/check-ydz.py`） | 27 个衣带诏事件每个非终点选项都有链出口、7 条章节注释归位、全目录集数/出处标注 **0 命中** |
| 加载期 / 全量 | 默认根 `LOAD OK`（**81 事件 / 28 角色 / 19 结局 / 2 开局**）、隔离根 `LOAD OK`；typecheck **PASS** / shared **67/67** / game-core **478/478** / web build `index-DLvGHcIx.js` |

### 13.5 边界

仅 `sanguo-2010` 的 5 个 yaml + 2 份文档；引擎 / schema / Spec / ADR / 前端 / `jjk-2006` 零改动。T-2 多套年号显示、第三章展开仍待拍板；未跑云冒烟 / CI / 真机点屏；未 push、未部署、未下线，`docs/RECOVERY_MERGE.md §6.3` 红线继续有效。按用户本轮说明，**不再记录存档拒载口径**。

## §14 第八轮 · 人物剧情补做（事件级分线）

### 14.1 问题与实测

| 用户点名 | 基线实测 |
|---|---|
| `190` 副本 / seed 3101 / 曹操 / 衣带诏剧情没做 | `probe-3101.mjs` 实测 seed 3101 转盘 = **曹操**。折叠后序列 `ev-ydz-arrival → ev-ydz-edict → roster → wine → leave → jiping → exposed → tianyi`，`ev-ydz-line-cao-1/2` 整条被跳过（只从 `ev-ydz-wheel` 转出），只剩 6 个旁观式专属选项，结局还叫「名册上没你的名字」。 |
| 徐州让城成了公共事件 | `ev-ch2-1` narrative 对 7 身份一律「印绶被推到你面前」，身份差异只在选项层。 |

**根因**：前几轮的「按身份」是选项级 `visibleWhen`，事件骨架与 narrative 公共；对「主角是谁决定这件事本身是否发生」的剧情不成立。

### 14.2 改动清单

| 位置 | 改动 |
|---|---|
| `ev-ch2-1` | 改中性分流事件（0 天），按 `origin` 路由到 `ev-ch2-1-liu / -cao / -yuan / -other`，四条各 2 天、统一接 `ev-ch2-2`。只有刘备分支叫「徐州 · 三让」，其余三支叙事明确印绶没递到自己手里。6 个 `opt-ch2-1-*` id 与全部 `ch2*` flag / if 回响原样保留。 |
| `ev-ydz-arrival` | 改按陈留 `origin` 分流：曹操 → `ev-ydz-line-cao-1`、刘备 → `ev-ydz-line-liu-1`、乌角鲨 → `ev-ydz-line-shark-1`（**复用**新开局人物链，链尾本就汇入 `ev-ydz-edict`）；袁绍 → 新增 `ev-ydz-tr-yuan-1`（河北 · 官渡前夜），虚构组 → 新增 `ev-ydz-tr-other-1`（没写上去的那一页）。不重转转盘、保留原 `origin`。 |
| 公共 7 段曹操选项 | 6 处 text + log 重写为当事人视角（簿子是他批的 / 七个名字要杀的是他 / 那句话是他说的 / 令是他准的 / 药是端给他的 / 抄检是他的人做的），第 7 段补 `opt-ydz-tianyi-cao`。动作仍「照旧」，天意照旧拉回官渡，**主线零改写**。 |
| `endings.yaml` | 新增 `end-ydz-tr-cao / -liu / -yuan`（priority 80，条件含 `ydzEntry eq 过渡`），压过通用 `end-ydz-transition`（70）；虚构组仍走通用，新开局分线（60）不受影响。 |

### 14.3 时间账（用户最看重）

- 主线**逐分钟不变**：分流 0 天 + 分支 2 天 = 原 2 天；锚点 1 = 11520、锚点 2 = 83520、ch3 = 84960、终止仍 `初平 1年3月2日`。
- 折叠局因复用人物链多 1~2 天：day7 入口 1月17 → 1月18/19 日，ch3 入口 3月10 → 3月11/12 日；全部由 `ydzDone` 自然终止、零 `advanceTo`、`worldTime` 单调、无陈留事件串入。
- 体验统计（seed 1 / 谋士）：事件 32 → **33**、单选项 5 → **6**（新增的分流事件对没参与的身份恰好 1 个选项，符合既定口径）、maxBlankRun 仍 **2**、终止仍 3月2日。衣带诏新开局仍 10 事件 / 每天一件 / 零空窗。

### 14.4 验证矩阵

| 项 | 结果 |
|---|---|
| 专项 `rebuild/smoke-character-lines.mjs` | 主线 **7/7**（各身份恰好命中自己的徐州分支、非刘备分支叙事无「让城」）、折叠 **6/6**（day7/ch3 × 谋士/刘备/曹操，人物链命中、曹操公共段 6 个专属选项、按身份结局） |
| `seed 3101` 曹操 ch3 折叠 | 徐州 → `ev-ch2-1-cao`；折叠后 `ev-ydz-line-cao-1 → -2 → edict …`；结局 `end-ydz-tr-cao`；时间单调、折叠点恒第 59 天 |
| `smoke-fold.mjs` 6 组 | **6/6 OK**（已支持 `EXPECT_ENDING` 按身份断言） |
| 陈留回归 | 整条时间线 **7/7**、死亡 **7/7**、if **7/7**、战争矩阵 **5/5**、玩家战死 **4/4**、fork **OK**、stall 兜底通过 |
| 衣带诏新开局 | **7/7**（seed 1/2/3/4/6/7/14），结局仍按新开局分线 |
| 静态 | 87 事件 id 无重复、65 条 `nextEventId` 零悬空、`check-ydz.py` 链出口与章节注释 **OK**、全目录集数 / 出处 **0 命中** |
| 加载期 / 全量 | 默认根 + 隔离根 `LOAD OK`（**87 事件 / 28 角色 / 22 结局 / 2 开局**，指纹 `541d796a…`）；typecheck **PASS** / shared **67/67** / game-core **478/478** / web build `index-DLvGHcIx.js` |

### 14.5 边界

仅 `sanguo-2010` 的 `events.yaml` / `endings.yaml` + 两份文档；引擎 / schema / ADR / Spec / 前端 / `jjk-2006` 零改动。建安五年仍是剧情层年号，T-2 显示层与第三章展开仍待拍板；未跑云冒烟 / CI / 真机点屏；未 push、未部署、未下线。
