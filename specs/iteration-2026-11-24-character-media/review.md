# 提案书 · 角色媒体与技能演出 V1（供外部评审）

> 目的：让不了解本仓库的评审者也能判断这份方案是否成立。
> 完整规格在 `README.md` / `requirements.md` / `design.md` / `tasks.md`；本文是自包含摘要 + 待挑刺的问题清单。

## 0. 一句话

给人物加**头像 / 立绘 / 多皮肤 / 自动换装 / 技能 CutIn**，并且**不把角色媒体做成底层引擎改造**。

## 1. 现状事实（都是可核对的代码位置）

| 事实 | 位置 |
|---|---|
| 人物定义在 `characters.yaml`（id / 技能 / 属性），**没有形象字段** | `specs/data/templates/jjk-2006/3.0.0/characters.yaml` |
| 资源协议已存在：`assetId / path / kind(portrait\|diff\|cg\|bgm) / characterRef / visibility / license` | `packages/shared/src/contract/asset-manifest.ts` |
| 媒体投影已存在：`state.media[{slot, assetId}]` → 投影 `{slot, assetId, url, alt}` | `packages/shared/src/v2.ts:819 / :1510` |
| 前端已认 `portrait*` 槽位并渲染立绘排 | `packages/rpg-ui/src/slots.ts`、`apps/web/src/StoryStage.tsx:187` |
| 磁盘上已有 6 张五条悟立绘，但**没有 `assets/manifest.yaml`** ⇒ 从未被下发 | `specs/data/templates/jjk-2006/3.0.0/assets/characters/*.png` |
| `ui.yaml` **不进语义指纹** | `packages/template-loader/src/index.ts` 的 `semanticFingerprintOf` |
| `assets/manifest.yaml` **进**语义指纹（只排除 `ui.yaml`） | 同上，`DECLARATIVE_FILES` |
| 战斗特效有游标：只播 `cast.seq > cursor` 的段 | `packages/rpg-ui/src/BattleFxLayer.tsx` |
| SW 把 `/api/*` 全部 network-only；`activate` 会删所有 `life-sim-*` 缓存 | `apps/web/scripts/build-sw.mjs:79 / :57` |
| 皮肤搬运的字段白名单只有 body / mind / identity / standing | `packages/game-core/src/v2/actors.ts:166` |
| 借名开局时 `selfId = characterId`（如 `npc-gojo`） | `packages/game-core/src/v2/turn.ts:148` |
| 战斗单位有 `characterId`，但没有 NPC 实例 | `packages/shared/src/v2.ts:304` |

## 2. 需求

1. 人物有头像与立绘（人物面板 / 叙事气泡 / 战斗面板）。
2. 多皮肤 + 自动切换：2006 高专 → 2017 教师 → 2018 新宿；显式切换可存读档。
3. 技能 CutIn：先「人物 + 技能名」再播现有 FX，可跳过。
4. 素材缺失 / 离线缺失 ⇒ 占位符，不阻塞游戏。
5. 自定义角色生图**只预留协议**，不实现模型调用与皮肤管理页。

## 3. 三个工程风险与裁决

### M1 · 指纹

**问题**：`assets/manifest.yaml` 在 `DECLARATIVE_FILES` 里，登记立绘会让语义指纹变化 ⇒ **所有旧档 `template_content_drift`**。
更隐蔽的是：**换算法本身**就会让旧档存的值对不上。

**方案**：三类指纹分工。

| 指纹 | 覆盖 | 变化时 |
|---|---|---|
| `semanticFingerprint` | 机制（world/characters/skills/items/statuses/events/…/lore），**排除 ui.yaml 与 assets/manifest.yaml** | 拒载 |
| `assetFingerprint` | manifest + 资源字节 | 只刷新资源 |
| `legacyFingerprint` | 旧算法（含 manifest） | 只用于识别旧档 |

加载时双哈希 + 版本号：

```
if 存档值 == v2     → 认
if 存档值 == legacy → 认，并就地升级为 { v2, fingerprintVersion: 2 }
else                → 拒载
后续带 fingerprintVersion: 2 的档只校验 v2
```

**安全性依据**（评审修正）：不是「legacy == v2」，而是「存档值 == 当前模板用**同一套旧算法**算出的值」
—— 这说明当前模板在旧算法眼里就是当年那份，而旧算法覆盖的是机制文件 + manifest 的**超集**，
所以机制文件逐个未变。**残留损失面**：存档时 manifest 存在、之后又被改过 ⇒ 仍拒载，不承诺全量无损。

### M2 · 离线媒体

**问题**：SW 把所有 `/api/*` 当 network-only，而媒体走 `/api/templates/:id/:v/assets/:assetId`；且 `activate` 会清掉 `life-sim-*` 前缀的所有缓存。

**方案**：独立 Cache Storage `character-media`（**不带 `life-sim-` 前缀**），只拦模板媒体 GET，`stale-while-revalidate`，默认 128 MB，按写入时间淘汰到 80%。不用永久 cache-first（同一 assetId 的图会被作者替换）。

### M3 · 演出顺序

**问题**：`BattleFxLayer` 拿到新 casts 就立刻播（CSS 自走），没有暂停入口 ⇒ CutIn 会和特效糊在一起。

**方案**：在 FX 消费层加轻量门控。`cast.seq` 入队 → 有 `cutIn` 就先播 → **完成 / 跳过 / 超时（durationMs+500 兜底）/ 卸载** 四条路径都 `release(seq)` → 再播 cast/trace/impact。不用固定 `holdMs`（连续施法、动画取消、卸载都会错位）。演出不阻塞内核结算。

## 4. 协议增量（4 处，全部可选字段）

| # | 位置 | 增量 |
|---|---|---|
| A | `schema/ui.ts` | 顶层 `characterMedia`；`FxOverride` 加 `cutIn { durationMs?, title? }` |
| B | `v2.ts` + `v2-state.ts` | `ActorSkinState { skinId?, customSkin? }` |
| C | `schema/common.ts` | Effect `{ type: "setSkin", who?, skinId: string \| null }` |
| D | 存档记录 | 追加 `assetFingerprint`（不参与拒载） |

**皮肤不参与搬运**：`skinId` / `customSkin` 不进 `ACTOR_FIELD_GROUPS` 任何一组 ⇒ 夺舍后形象跟着身体走（羂索夺舍夏油 = 显示夏油；缝合线由剧情 `setSkin` 切）。

## 5. 皮肤与条件

```
skinId（持久化） > skinRules 首个命中（实时算） > defaultSkin > 占位符
```

- 槽位回退**只在同一皮肤内**：`avatar → bust → full → 占位符`；
  演出素材是 `skillCutIns[skillId] → cutIn → bust → full → 纯文字`（**专属优先于通用**）。
- `skinRules[].when` 复用现有 Condition，但 **V1 加载期只放行 `time` / `flag` / `eventOccurred` 三类**；`status` / `attribute` / `relation` 报 `ui_invalid`。
- **禁止**临时替换 `state.player` / `selfId` 求条件 —— 会污染关系图与观察者。

## 6. 验收（18 条，摘要）

旧档可用 / 2006→2017 自动换 / 时间回溯恢复 / 显式切换存读档一致 / 清覆盖恢复 / 原作开局皮肤完整 / 自建角色占位符 / 敌人召唤物按 characterId / 同技能不同人素材不同 / AoE 一次 / 多段一次 / 跳过不阻塞 / 读档不重播 / 资源缺失降级 / 离线可看 / 只改媒体不拒载 / 夺舍形象不串 / 机制漂移仍拒载。

## 7. 交付切分

**V1.0（先做）**：P0 协议+指纹+兼容 → P1 资源与缓存 → P2 皮肤与 Self。
**V1.1（V1.0 验收通过后）**：P3 CutIn 与门控 → P4 模板实装与回归。

分界线是**静态媒体 vs 时序演出**；头像与立绘共用同一条链路，不拆。**P0 不完成不许动前端**。

---

## 8. 请重点评审的问题

1. **双哈希兼容是否够用？** 有没有更稳的做法（例如把算法版本写进存档）？我担心的是「旧档里没有版本号」这个既成事实。
2. **`legacy == v2` 的安全性论证**（超集相等 ⇒ 机制必然未变）有没有漏洞？
3. **媒体缓存用 Cache Storage + SWR** 是否会在「同一 assetId 换图」时给出过期图？我接受一次访问的延迟，但不能接受永久旧图。
4. **CutIn 门控放在 `BattleFxLayer` 内部**是否会让这个组件变成第二个「演出引擎」？有没有更薄的切点（例如在 VM 层给 cast 插入一个 `cutIn` 段）？
5. **条件子集砍到只剩 time/flag/event** 是否够支撑 2006→2017→2018 的三段过渡？会不会很快就需要 `status`（受伤、变身）？
6. **`setSkin` 作为 Effect** 会不会被滥用来做「剧情换装」以外的事（例如战斗中切皮肤改变表现）？需要限制作用域吗？
7. **占位符复用文字头像**是否足够？还是应该默认给一个人形剪影？
8. **有没有更小的第一版**？例如先只做头像（avatar 槽），立绘与 CutIn 放第二轮 —— 是否比现在这个「一次做完但每波可独立验收」的切法更稳？

---

## 9. 外部评审结论（2026-11-24）

**Approve with changes** —— 架构通过，十项修订已并入 `README` / `requirements` / `design` / `tasks` 与三节 ADR：

1. §3.3 安全论证改为「同一旧算法下相等」；新增 `fingerprintVersion`；**不承诺全量无损**。
2. 演出素材优先级：`skillCutIns[skillId]` 优先于通用 `cutIn`。
3. 回滚口径：向后兼容但**不可逆**（旧 Schema 是 strict，读不了带 `skinId` 的新档）。
4. 缓存补 `event.waitUntil` / 尊重 HTTP 头 / 404 失效 / 并发去重 / `?v=<assetFingerprint>` 断代；FIFO 淘汰。
5. 门控抽成 `useCastPlayback` Hook，`release` 幂等，卸载走 `cancel`；补连续施法 / 跨战斗 / 结算页边界。
6. 条件子集保持三类；时间回溯只保证时间条件重算。
7. `setSkin` 只写**已存在的可写实例**，校验归属，不改数值身份，不支持战斗临时单位。
8. 占位符沿用文字头像，缺失立绘保持布局。
9. 解析器统一 `ActorMediaRef`；演出用**释放时快照**。
10. 拆成 **V1.0 静态媒体 / V1.1 技能演出** 两个交付版本。
