# design · 角色媒体与技能演出 V1

> 上游：`README.md`（裁决）、`requirements.md`（R1–R12）。
> 本文的每一条都对应现有代码里的一个位置；**没有新引擎**，只有解析器、一个 Effect、一个门控。

## 1. 数据流

```
characters.yaml ──┐
ui.yaml.characterMedia ──┼─→ SkinResolver ─→ AssetResolver ─→ MediaVM ─→ rpg-ui
assets/manifest.yaml ──┘         ↑
                                 │
                      state.player / state.npcs[i].skinId
```

四段解耦，与 `README` 的裁决一致：

- **人物身份**：`characters.yaml`（不新增文件、不改 schema 语义）。
- **皮肤集合**：`ui.yaml.characterMedia`（表现域，不进语义指纹）。
- **资源本体**：`assets/manifest.yaml`（只影响「能不能看见图」）。
- **演出**：`ui.presentation.skills[].cutIn`（表现域）。

## 2. 协议增量（4 处，全部向后兼容）

| # | 位置 | 增量 | 兼容性 |
|---|---|---|---|
| A | `packages/shared/src/schema/ui.ts` | 顶层 `characterMedia`；`FxOverrideSchema` 增 `cutIn` | 旧模板不写 ⇒ 行为不变 |
| B | `packages/shared/src/v2.ts` | `ActorSkinState { skinId?: string; customSkin?: Skin }` 并入 `V2Player` / `V2Npc` 公共结构 | 字段可选，旧档缺省 |
| C | `packages/shared/src/v2-state.ts` | 存档校验同步这两个可选字段 | 同上 |
| D | `packages/shared/src/schema/common.ts` | Effect 增 `{ type: "setSkin", who?, skinId: string \| null }` | 旧模板不写即无 |
| E | 存档记录（`local/worldRepo.ts`、服务端 world 文件） | 追加可选 `fingerprintVersion?: 2` 与 `assetFingerprint?: string` | 缺省按 1 代处理（走 §3.3 双哈希） |

> A/C 的 schema 全是 `.strict()`（`ui.ts` 有 31 处），**漏一处模板就 `ui_invalid`**。
> B 的两个字段**不进 `ACTOR_FIELD_GROUPS`**（`packages/game-core/src/v2/actors.ts`），
> 和 `age` 一样属于「不搬运」的那一档 —— 理由见 §5.1。

## 3. 指纹：三类分工 + 旧档兼容（M1）

### 3.1 现状问题

`packages/template-loader/src/index.ts`：

```ts
export const DECLARATIVE_FILES = [ … "lore.md", "assets/manifest.yaml", "ui.yaml" ];
// semanticFingerprintOf: 只 filter 掉 ui.yaml
```

⇒ 登记立绘 = 语义指纹变 = **所有旧档 `template_content_drift`**。

### 3.2 三类指纹

| 指纹 | 覆盖 | 变化时 |
|---|---|---|
| `semanticFingerprint` | 机制：world / characters / skills / items / statuses / events / equipment / combat-ai / opening / endings / evaluation / rules / lore | **沿用拒载**（真正的漂移） |
| `assetFingerprint` | `assets/manifest.yaml` + 资源文件字节 | **只刷新资源，不拒载** |
| `legacyFingerprint` | 旧算法（含 manifest） | **只用于识别旧档**，不对外下发 |

新算法的 `semanticFingerprint` = 现有集合 **再排除 `assets/manifest.yaml`**。
`assetFingerprint` 已有实现（`templates.ts` 的 `asset.fingerprint`），本轮只是把它写进存档记录。

### 3.3 旧档兼容（外部评审修订 2026-11-24）

存档里只有一个 `fingerprint: string`（`apps/web/src/local/worldRepo.ts`）。
换算法后它必然对不上 —— 所以加载时**同时算两个值**，并给新档写上版本号：

```
onLoad(record):
  if record.fingerprintVersion === 2:
      return record.fingerprint === v2 ? ok : reject   // 新档只认 v2
  v2     = semanticFingerprintOf(files, template)       // 新算法：不含 manifest
  legacy = semanticLegacyFingerprintOf(files, template) // 旧算法：含 manifest
  if record.fingerprint === v2:     ok(record)
  elif record.fingerprint === legacy: ok(record); 升级为 { fingerprint: v2, fingerprintVersion: 2 }
  else:                             reject(template_content_drift)
```

**安全性依据（上一版写错了，这里改正）**：
安全的判据**不是**「legacy 与 v2 相等」，而是

> 存档里的值与**当前模板用同一套旧算法**算出来的值相等 ⇒ 这说明「当前模板在旧算法眼里
> 就是当年那份」，而旧算法覆盖的文件集是机制文件 + manifest 的**超集**
> ⇒ 机制文件逐个未变、manifest 也未变 ⇒ 不可能有真实漂移被放行。

换成「legacy == v2」来论证是循环论证：两值相等只能说明 manifest 没参与差异，
不能说明存档当年用的就是这套算法。**新档一律带 `fingerprintVersion: 2`，此后只校验 v2**，
所以双哈希只是**一次性的升级通道**，不会长期并存。

### 3.4 残留风险（不承诺全量无损）

| 场景 | 结果 |
|---|---|
| 存档时模板**没有** manifest（当前仓库就是这样） | `legacy == v2`，直接认 ✅ |
| 存档时 manifest 存在，之后**没改** | `legacy` 命中 ⇒ 升级 ✅ |
| 存档时 manifest 存在，之后**改过** | 两个值都对不上 ⇒ **仍会判漂移** ⚠️ |

⚠️ 第三行是硬损失，**不做兜底**：旧档里没有任何信息能区分「manifest 改了」还是「机制改了」，
任何「猜一下应该没事」的做法都会放行真实漂移。当前模板从未有过 `assets/manifest.yaml`
（`ls specs/data/templates/jjk-2006/3.0.0/` 可证），所以本轮实际损失为零；升级后每个存档都带
`fingerprintVersion: 2`，这一格不再出现。

### 3.5 资源缺失不得中断游戏

`referenceAsset` 等表现层 Effect 在 `agent-runtime` / `engine-api` 里落 `state.media`。
本轮追加约束：

- `state.media` 里指向**未登记或已删除** `assetId` 的条目，投影时**丢弃**并记 info 日志；
- 前端拿不到该 asset ⇒ `url` 为空 ⇒ 组件渲染占位符；
- **不进 `droppedPending`、不写 history、不影响结算**。

## 4. 解析器（三个，全部纯函数）

放在 `packages/game-core/src/v2/presentation/`（与 `effects.ts` / `style.ts` 同层）。
输入统一成一个轻量引用（**只是解析层入参，不新增人物实例体系**）：

```ts
interface ActorMediaRef {
  actorId: string;        // 世界里的实例 id（玩家 = selfId；战斗单位 = 单位 id）
  characterId?: string;   // 模板人物 id（敌人/召唤物没有 NPC 实例时用它查皮肤集合）
  skinId?: string;        // 实例上的显式皮肤（持久化的那一个）
  customSkin?: Skin;      // 预留，V1 不产生
}

resolveSkin(ref: ActorMediaRef, media: CharacterMediaMap | undefined, ctx: SkinContext): SkinResolution | undefined
resolveCharacterMedia(ref: ActorMediaRef, slot: MediaSlot, media, ctx): string | undefined      // → assetId
resolveCutIn(ref: ActorMediaRef, skillId: string, ui): CutInPlan | undefined
```

- `ctx` 只含 `{ flags, worldTime, facts }` —— 条件子集只吃这三样（§5.3）。
- 三个函数**只读**，不写 state；命名里不出现任何作品专名。
- **技能演出用释放时的媒体快照**：CutIn 的 `assetId` 在 cast 生成时就解析好并随 `fx.casts[i]`
  下发，播放时不再回查 state —— 否则演出途中一次 `setSkin` 会把同一次释放的立绘换掉。

### 4.1 占位符（S8）

复用现有文字头像：`name.slice(0, 1)` + 由 `characterRef` 哈希出的稳定底色。
不新增图形资产、不改 `AssetDescriptor`。

**布局约束**：头像位固定为圆形方框；立绘位缺失时**保持原布局**（留白），
不插入大面积剪影占位 —— 剪影会把「没有图」渲染成「有图但难看」，反而更显眼。

## 5. 皮肤

### 5.1 归属身体（S1）

`skinId` / `customSkin` **不出现在** `ACTOR_FIELD_GROUPS` 的 body / mind / identity / standing 任何一组。
`transplantActor` 只覆盖列出来的字段 ⇒ 未列字段**留在目标身上**。

语义：羂索夺舍夏油 ⇒ `inheritActor{ from: npc-kenjaku-body, to: npc-geto, groups: [mind] }`
⇒ `npc-geto` 的 `skinId` 不变 ⇒ 显示夏油的形象。✅

（`age` 已有同样的先例：它是「现算」而不是「搬运」，注释写在 `actors.ts` 上方。）

### 5.2 优先级与持久化

```
skinId（持久化） > skinRules 首个命中（实时算，不落盘） > defaultSkin > 占位符
```

- 只有 `skinId` 落盘；`skinRules` 每次投影重算 ⇒ **时间回溯自动恢复**（验收 3）。
- `setSkin` 写 `skinId`；`skinId: null` 清空 ⇒ 回到规则。

### 5.3 条件子集（S4）

加载期用**白名单**校验 `skinRules[].when`：

```ts
// packages/game-core/src/v2/presentation/media.ts
export const SKIN_RULE_CONDITION_KEYS = ["time", "flag"] as const;
```

「全局事件事实」在 `ConditionSchema` 里**没有独立谓词** —— 项目惯例是让事件写旗标，
所以 `flag` 已经覆盖它；不为此新增条件类型。

- 命中白名单 ⇒ 通过；否则 `ui_invalid: skin_rule_condition_unsupported`（带路径）。
- **不**替换 `state.player` / `selfId` 求值 —— 那会污染关系图与观察者，用户明确禁止。
- 求值上下文直接用 `{ state, lookup }`（与 `checkAllConditions` 同签名），
  所以「全局」= 现有 self 视角，恰好就是 V1 要的那一档。

### 5.4 播放/展示位

| 位置 | 槽位 | 组件 |
|---|---|---|
| 人物详情页头部 | `avatar` | `CharacterAvatar`（新） |
| 叙事气泡左侧 | `avatar` | `StoryStage` 内置 |
| 立绘排 | `bust` | 复用 `StoryStage` 的 `portraitsOf` |
| 全屏插画 | `full` | 复用 `cg*` 判定（`slots.ts`） |
| CutIn | `cutIn` | `SkillCutIn`（新，见 §7） |

## 6. 媒体缓存（M2）

### 6.1 现状

`apps/web/scripts/build-sw.mjs`：

- `if (url.pathname.startsWith("/api/")) return;` ⇒ 媒体永远是网络；
- `activate` 里 `keys.filter(k => k.startsWith("life-sim-") && k !== CACHE_NAME).map(delete)`
  ⇒ 任何 `life-sim-` 前缀的缓存都会被**每次部署清掉**。

### 6.2 方案

| 项 | 值 |
|---|---|
| 缓存名 | `character-media`（**不带 `life-sim-` 前缀**，因此不被 activate 清理） |
| 拦截范围 | 仅 `GET /api/templates/:id/:version/assets/:assetId` |
| 策略 | `stale-while-revalidate`：先回缓存，后台 `fetch` 覆盖（后台写必须 `event.waitUntil` 包住，否则 SW 随时被回收，写一半） |
| 上限 | 128 MB（生成脚本里的常量） |
| 淘汰 | **FIFO**：按 `x-cached-at` 升序删到 80%（不做真 LRU，`Cache` 读不到访问时间，伪 LRU 反而更贵） |
| 版本参数 | 资源 URL 带 `?v=<assetFingerprint 前 8 位>` —— 作者换图后 URL 变，天然不命中旧缓存 |
| 404 | 命中缓存的响应若后台回 404 ⇒ **删除该条**并从缓存直接返回失败（不再无限回旧图） |
| 并发 | 同一 URL 的后台刷新用 `pending: Map<url, Promise>` 去重，避免十张图同时刷新时写同一个 key |
| 失败 | 网络失败 ⇒ 保留旧缓存继续用；`<img onError>` ⇒ 占位符 |

**不用永久 cache-first**：同一 `assetId` 的图会被模板作者替换，靠 `?v=` 断代 + SWR 覆盖。

### 6.3 不做

- 不建 IndexedDB 图片索引（Cache Storage 已经是索引）。
- 不缓存 `/api/templates`（JSON）与 `/package`（体积大、已有 IDB 包缓存）。

## 7. CutIn 与 FX 门控（M3 · V1.1）

### 7.1 形态：一个 Hook，不是第二个引擎

外部评审要求「抽成轻量 Hook」，采纳。`useCastPlayback(fx)` 只做三件事：

1. 按 `cast.seq` 维护游标（沿用 `BattleFxLayer` 现有的 `cursorRef` 语义）；
2. 判定这一条 cast 要不要先播 CutIn；
3. `release(seq)` 放行 —— **幂等**，多次调用只生效一次。

`BattleFxLayer` 从「自己算游标」退化成「消费 `useCastPlayback` 给的 `pending`」，
组件本身不再增长职责；不新建通用动画引擎，也不引入全局调度器。

```
idle ──新 cast.seq──→ 有 cutIn? ──是──→ cutIn(播放)
                        │                 ├─ 完成 ─┐
                        │                 ├─ 跳过 ─┤──→ release(seq) → 播 cast/trace/impact
                        │                 └─ 超时 ─┤
                        │                          │
                        └──否──────────────────────┴─→ 直接播
```

- **门控键 = `cast.seq`**：`release(seq)` 只放行这一条及之前的段。
- 门控**只在表现层**：`battleActionV2` 的返回、state 写入、结算全都不等它。
- **卸载即取消**：`useEffect` cleanup 调 `cancel()` 而不是 `release()` —— 组件没了就不该再启动
  后续 FX（那是「对着空气播动画」，还会在结算页闪一下）。

### 7.2 去重（S6）

CutIn 的触发键 = `cast.seq`（`packages/shared/src/v2.ts:970`）。
一条 cast = 一次技能释放（`resolveBattleFx` 对 AoE 只产一条 cast，多段命中进 `hits[]`），
所以「AoE 播一次、多段播一次」由数据形状天然保证；Hook 里再用 `playedSeqs` 防重入。
`release` 与 `cancel` 都要能从 `playedSeqs` 之外独立生效（幂等用 `released` 集合判定）。

### 7.3 跳过与超时

- 点击/触摸任意处 ⇒ `release(seq)` + 立刻卸载 CutIn。
- `durationMs`（默认 1200）到时 ⇒ 自动 `release`；**兜底计时器** = `durationMs + 500`，
  防止动画事件没触发时把 FX 永久卡住。
- 卸载 ⇒ `cancel()`。

### 7.4 素材优先级（外部评审修正）

```
skillCutIns[skillId] → cutIn → bust → full → 纯文字
```

**专属素材优先于通用素材**。上一版把 `cutIn` 写在 `skillCutIns` 前面是错的：
一旦角色配了通用 `cutIn`，专属演出就永远轮不到。

### 7.5 边界用例（V1.1 验收）

| 场景 | 期望 |
|---|---|
| 连续施法（两次技能在同一响应里） | 两条 cast 依次播，CutIn 各播一次 |
| 跨战斗重置 | 新战斗 `fx.seq` 归零 ⇒ Hook 游标重置，不误判「已播过」 |
| 最后一次技能 + 结算页切换 | 战斗结束切到战评面板时 ⇒ `cancel()`，不残留、不闪 |
| 读档 | 首帧把游标推到 `fx.seq`，历史 cast 不重播 |

## 8. 敌人与召唤物（S5）

| 场景 | 用什么查 |
|---|---|
| 玩家 | `state.player.id`（reuse 时 = `npc-gojo`，见 `turn.ts:148` 的 `selfId = c.id`） |
| NPC | `state.npcs[i].id` |
| 敌人 / 召唤物 | `Combatant.characterId`（`packages/shared/src/v2.ts:304`） |

解析器签名接受「实例 id 或 characterId」，内部只做一次 `characterMedia[ref]` 查表；
**不为战斗单位造 NPC 实例**，也不读 `state.npcs`。

## 9. 资产规范（S7）

| 资源 | 推荐 | 体积 |
|---|---|---|
| 头像 | 256 × 256 | ≤ 50 KB |
| 半身立绘 | 长边 1024 | ≤ 300 KB |
| 全身立绘 | 长边 1536 | ≤ 500 KB |
| 技能演出 | 长边 1536 | ≤ 500 KB |

- WebP（带 alpha），`<img loading="lazy" decoding="async">`。
- **不进 Schema**：这些是生产规范，不是校验规则（校验只认 `path` 合法 + 扩展名白名单）。

## 10. 施工边界

| 文件 | 动什么 |
|---|---|
| `packages/shared/src/schema/ui.ts` | `CharacterMediaSchema` / `SkinSchema` / `SkinRuleSchema` / `CutInSchema` |
| `packages/shared/src/schema/common.ts` | `setSkin` Effect |
| `packages/shared/src/v2.ts` + `v2-state.ts` | `ActorSkinState` |
| `packages/game-core/src/v2/presentation/media.ts`（新） | 三个解析器 |
| `packages/game-core/src/v2/engine.ts` | `setSkin` case |
| `packages/game-core/src/v2/projection.ts` | 投影 `media`：按在场角色补 `portrait.<id>` / `avatar.<id>` |
| `packages/template-loader/src/index.ts` | 指纹拆两套 + `characterMedia` 引用校验 + 条件白名单 |
| `apps/web/scripts/build-sw.mjs` | 媒体缓存 |
| `packages/rpg-ui/src/CharacterAvatar.tsx` | 新组件（V1.0） |
| `packages/rpg-ui/src/useCastPlayback.ts` + `SkillCutIn.tsx` | 新 Hook + 组件（V1.1） |
| `packages/rpg-ui/src/BattleFxLayer.tsx` | 改成消费 Hook（V1.1） |
| `specs/data/templates/jjk-2006/3.0.0/assets/manifest.yaml` | 新建（6 张现有图 + 后续素材） |
| `specs/data/templates/jjk-2006/3.0.0/ui.yaml` | `characterMedia` + `cutIn` |

**不动**：`characters.yaml`（不加字段）、`ActorFieldGroups`（不加 skin）、事件/技能机制、`battle.ts` 结算。

## 11. 风险与回滚

| 风险 | 处置 |
|---|---|
| 指纹算法换掉后旧档被误判 | §3.3 双哈希；上线前用 `test/unit/template-cache.test.ts` 的旧档 fixture 回归 |
| SW 缓存把媒体和 App Shell 生命周期绑死 | 缓存名不带 `life-sim-` 前缀；`activate` 里显式跳过 |
| CutIn 卡住 FX | 门控必须有**超时兜底**（`durationMs + 500ms` 强制放行） |
| 媒体配置写错导致 `ui_invalid` | 加载期校验给路径级报错（`ui.characterMedia.npc-x.skins.y.avatar`） |
| 引擎里混进专名 | `test/unit/engine-generic.test.ts` 已覆盖 |

回滚：四处协议增量全部是**可选字段** —— 但这里要说准（外部评审核正）：

- **保证**：新代码读旧存档（旧档没有 `skinId` / `fingerprintVersion`，按缺省处理）。
- **不保证**：旧代码读新存档。`packages/shared/src/v2-state.ts` 是 `.strict()` 的，
  回滚到旧版本后，带 `skinId` 的存档会被判 `schema_invalid`。
- 所以这是一次**向后兼容、但不可逆**的升级：回滚代码之前必须先回滚存档，或接受旧档丢失。
- 缓解：`skinId` 只影响展示，回滚前可跑一次「剥字段」脚本（不实现，写在这里备案）。
