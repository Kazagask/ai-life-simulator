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

### 3.3 旧档兼容（用户点出的坑）

存档里只有一个 `fingerprint: string`（`apps/web/src/local/worldRepo.ts`）。
换算法后它必然对不上 —— 所以加载时**同时算两个值**：

```
onLoad(record):
  v2     = semanticFingerprintOf(files, template)          // 新：不含 manifest
  legacy = semanticLegacyFingerprintOf(files, template)    // 旧：含 manifest
  if record.fingerprint == v2:
      ok(record)                        // 新档
  else if record.fingerprint == legacy:
      ok(record); record.fingerprint = v2; persist(record)   // 旧档 → 就地升级
  else:
      reject(template_content_drift)
```

**为什么 `legacy` 相等是安全的**：旧算法的文件集是**超集**（多了 manifest），
两套文件集算出来的哈希相等 ⇒ 连 manifest 都没变 ⇒ 机制必然也没变。
所以「用旧值放行」不会放过任何真实漂移，只会放过「manifest 变了但机制没变」这一种 —— 而它恰好是我们想要的。

### 3.4 残留风险（写清楚，不藏）

| 场景 | 结果 |
|---|---|
| 存档时模板**没有** manifest（当前仓库就是这样） | `legacy == v2`，直接认新档 ✅ |
| 存档时 manifest 存在，且之后**改过** | 两个值都对不上 ⇒ 判漂移 ⚠️（唯一损失面） |
| 存档时 manifest 存在，之后没改 | `legacy` 命中 ⇒ 就地升级 ✅ |

⚠️ 这一格的代价是「升级后第一次加图可能让极少数旧档拒载」。当前模板**从未有过**
`assets/manifest.yaml`（`ls specs/data/templates/jjk-2006/3.0.0/` 可证），所以**实际损失为零**；
以后每个存档都带 `v2`，这一格永远不会再出现。要在 ADR 里留一句「这是单向升级，代价只在本轮」。

### 3.5 资源缺失不得中断游戏

`referenceAsset` 等表现层 Effect 在 `agent-runtime` / `engine-api` 里落 `state.media`。
本轮追加约束：

- `state.media` 里指向**未登记或已删除** `assetId` 的条目，投影时**丢弃**并记 info 日志；
- 前端拿不到该 asset ⇒ `url` 为空 ⇒ 组件渲染占位符；
- **不进 `droppedPending`、不写 history、不影响结算**。

## 4. 解析器（三个，全部纯函数）

放在 `packages/game-core/src/v2/presentation/`（与 `effects.ts` / `style.ts` 同层）：

```ts
resolveSkin(actor: { id: string } | { characterId: string }, media: CharacterMediaMap | undefined, ctx: SkinContext): SkinResolution | undefined
resolveCharacterMedia(actorIdOrCharacterId, slot: MediaSlot, media, ctx): string | undefined   // 返回 assetId
resolveCutIn(casterIdOrCharacterId, skillId, ui): { assetId?: string; title: string; durationMs: number } | undefined
```

- `ctx` 至少含 `{ flags, worldTime, facts }` —— 条件子集只吃这三样（§5.3）。
- 三个函数**只读**，不写 state；命名里不出现任何作品专名。

### 4.1 占位符（S8）

复用现有文字头像：`name.slice(0, 1)` + 由 `characterRef` 哈希出的稳定底色。
不新增图形资产、不改 `AssetDescriptor`。

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
const SKIN_RULE_CONDITIONS = ["time", "flag", "eventOccurred", "eventNotOccurred"] as const;
```

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
| 策略 | `stale-while-revalidate`：先回缓存，后台 fetch 覆盖 |
| 上限 | 128 MB（常量，可在生成脚本里改） |
| 淘汰 | 插入前若超限，按 `Cache` 里存的 `x-cached-at` 升序删到 80% |
| 失败 | `catch` ⇒ 走网络 ⇒ 网络也失败 ⇒ 让 `<img>` 走占位符 |

**不用永久 cache-first**：同一 `assetId` 的图会被模板作者替换（`assetFingerprint` 变了），
SWR 能让下一次访问拿到新图。

### 6.3 不做

- 不建 IndexedDB 图片索引（Cache Storage 已经是索引）。
- 不缓存 `/api/templates`（JSON）与 `/package`（体积大、已有 IDB 包缓存）。

## 7. CutIn 与 FX 门控（M3）

### 7.1 状态机（在 `BattleFxLayer` 内部，不新建组件管全局）

```
idle ──新 cast.seq──→ 有 cutIn? ──是──→ cutIn(播放)
                        │                 ├─ 完成 ─┐
                        │                 ├─ 跳过 ─┤
                        │                 ├─ 超时 ─┤
                        │                 └─ 卸载 ─┴─→ release(seq) → 播 cast/trace/impact
                        └──否──────────────────────────→ 直接播
```

- **门控键 = `cast.seq`**：`release(seq)` 只放行这一条及之前的段。
- 现有游标语义（`BattleFxLayer.tsx` 的 `cursorRef`）保留：首次挂载推游标 ⇒ 读档不重播（验收 13）。
- 门控**只在表现层**：`battleActionV2` 的返回、state 写入、结算全都不等它。

### 7.2 去重（S6）

CutIn 的触发键 = `${cast.seq}`（`BattleFxCast` 已有，见 `packages/shared/src/v2.ts:970`）。
一条 cast = 一次技能释放（`resolveBattleFx` 对 AoE 只产一条 cast，多段命中进 `hits[]`），
所以「AoE 播一次、多段播一次」由数据形状天然保证；门控层再加一个 `playedSeqs` 集合防重入。

### 7.3 跳过与超时

- 点击/触摸任意处 ⇒ `release(seq)` + 立刻卸载 CutIn。
- `durationMs`（默认 1200）到时 ⇒ 自动 `release`。
- `useEffect` cleanup ⇒ `release`（组件卸载 / 切页）。

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
| `packages/rpg-ui/src/CharacterAvatar.tsx` / `SkillCutIn.tsx` | 新组件 |
| `packages/rpg-ui/src/BattleFxLayer.tsx` | 门控 |
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

回滚：四处协议增量全部是**可选字段**，回滚只需撤前端与配置；存档里的 `skinId` 会被旧代码忽略。
