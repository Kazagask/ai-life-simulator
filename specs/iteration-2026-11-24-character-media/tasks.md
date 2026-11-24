# tasks · 角色媒体与技能演出

> 每个 T 都是**可独立验收**的一刀。**V1.0 全绿并验收通过后，才允许开 V1.1**。
> 验收命令默认在仓库根执行（沙箱内需关闭沙箱，见 `AGENTS.md`「已知环境坑」）。

---

# V1.0 · 静态媒体

## P0 · 协议、指纹、兼容（不做完不许动前端）

| # | 任务 | 动哪里 | 验收 |
|---|---|---|---|
| T-01 | 三节 ADR：皮肤归身体（50）/ 媒体解析与占位（60）/ 三类指纹与媒体缓存（70） | `docs/adr/` | 每节含「不变量 / 决定 / 被否方案」；口径与本文一致 |
| T-02 | Schema 增量：`CharacterMedia` / `Skin` / `SkinRule`；`ActorSkinState`；`setSkin` Effect | `packages/shared/src/schema/ui.ts`、`common.ts`、`v2.ts`、`v2-state.ts` | `pnpm typecheck`；`test/unit/character-media-schema.test.ts`（合法 3 / 非法 5 例） |
| T-03 | 指纹：`semanticFingerprintOf` 排除 manifest；新增 `semanticLegacyFingerprintOf`；存档写 `fingerprintVersion: 2` + `assetFingerprint` | `template-loader`、`apps/web/src/local/*`、`apps/server/src/templates.ts` | `test/unit/fingerprint-compat.test.ts`：①只改 manifest ⇒ 语义指纹不变 ②旧值命中 legacy ⇒ 放行并写 v2 ③改技能 ⇒ 仍判漂移 ④带 `fingerprintVersion: 2` 的档不再走双哈希 |
| T-04a | 加载期校验：角色必须存在；皮肤里的 `assetId` 必须已登记（无 manifest 时跳过）；`skinRules[].when` 只放行 `time`/`flag` | `game-core/presentation/media.ts` + `template-loader` | 三条反例各报一条 `character_media_invalid`；`inspect check` 仍 0 error ✅ 已完成 |
| T-04b | `setSkin.skinId` 归属校验（**P2 落**）：模板里一旦真的用了 `setSkin`，再按 `who` 精确校验；`who` 缺省时目标角色要到开局才知道，加载期做不了 | `template-loader` | 见 T-11 |

**P0 出口**：现有 874 例绿 + 新增用例绿 + 本机 `data/worlds/*.json` 可载入的那些仍可载入。

## P1 · 资源与缓存

| # | 任务 | 动哪里 | 验收 |
|---|---|---|---|
| T-05 | 建 `assets/manifest.yaml`：登记现有 6 张五条图 | 模板 | `/api/templates/jjk-2006/3.0.0/assets/<id>?v=…` 返回 200；`inspect check` 0 error |
| T-06 | SW 媒体缓存：`character-media`、SWR、128 MB FIFO、`event.waitUntil`、404 失效、并发去重、URL 带 `?v=` | `apps/web/scripts/build-sw.mjs` | 构建产物含 `character-media`；`event.waitUntil` 包裹后台写；手动 e2e：二次访问命中、断网仍显示 |
| T-07 | `CharacterAvatar` + 文字占位符 | `packages/rpg-ui/src/CharacterAvatar.tsx` | 用例：有图渲图 / 无图渲首字 / 立绘位缺失保持布局 |
| T-08 | 投影补 `media`：player / npcs / 战斗单位 → `avatar.<id>`、`portrait.<id>`；未登记 assetId 不进投影 | `packages/game-core/src/v2/projection.ts` | `test/unit/media-projection.test.ts` |

## P2 · 皮肤与 Self

| # | 任务 | 动哪里 | 验收 |
|---|---|---|---|
| T-09 | 三个解析器 + `ActorMediaRef` + 槽位回退（同皮肤内） | `packages/game-core/src/v2/presentation/media.ts`（新） | `test/unit/skin-resolve.test.ts`：三级回退、不跨皮肤、未知角色 ⇒ undefined |
| T-10 | `skinRules` 求值 + 优先级链 | 同上 | 用例：`skinId` 覆盖规则；清空后规则生效；**时间回溯后回到 student** |
| T-11 | `setSkin` Effect：写 `skinId`、`null` 清空、只写可写实例、战斗临时单位跳过 | `engine.ts`、`common.ts` | 用例：写→存读档一致；`null`→恢复自动；不存在的人 ⇒ 静默跳过；敌人 ⇒ 跳过 |
| T-12 | Self 适配：`reuse` 时完整继承皮肤集合；`new` 时占位符 | 投影 + 组件 | 用例：`who.reuse=npc-gojo` ⇒ student；`who.new` ⇒ 占位符不报错 |
| T-13 | 夺舍不改皮肤（靠「不进字段组」） | `actors.ts`（不改，只加注释） | 用例：A 夺舍 B ⇒ B 的 `skinId` 不变 |
| T-14 | 模板实装三套皮肤 + 两条 `skinRules`（时间）+ V1.0 验收 | 模板 `ui.yaml` | 15 条 V1.0 验收全绿，记录在 `acceptance.md` |

**V1.0 出口**：`tsc` 0 错、`pnpm test` 全绿、`inspect check` 0 error（warn 不新增）、`web build` 通过、线上冒烟。

---

# V1.1 · 技能演出（V1.0 验收通过后开）

| # | 任务 | 动哪里 | 验收 |
|---|---|---|---|
| T-15 | `useCastPlayback(fx)`：游标 + `release(seq)`（幂等）+ `cancel()` + `playedSeqs` | `packages/rpg-ui/src/useCastPlayback.ts`（新） | 单测：release 两次只生效一次；cancel 后不再放行 |
| T-16 | `SkillCutIn` 组件：立绘 + 技能名 + 进度 + 点击跳过 | `packages/rpg-ui/src/SkillCutIn.tsx`（新） | 组件用例：进度到点回调、点击立即回调 |
| T-17 | `BattleFxLayer` 改成消费 Hook；卸载走 `cancel` | `BattleFxLayer.tsx` | 用例：有 cutIn 时 FX 延后；卸载不启动后续 FX |
| T-18 | 素材优先级 `skillCutIns[skillId] → cutIn → bust → full → 文字` + **释放时快照** | `media.ts`、`presentation/fx.ts` | 用例：专属命中时不取通用；演出中 `setSkin` 不影响本次 cast |
| T-19 | 边界用例：连续施法 / 跨战斗重置 / 最后一次技能切结算页 / 读档 | 测试 | 四条各一例 |
| T-20 | 模板实装 CutIn + V1.1 验收 | 模板 | V1.1 8 条验收全绿 |

## 施工顺序上的两条硬规矩

1. **P0 不做完不许动前端**：指纹换算法的窗口只有一次，前后端一起改会让「谁把旧档判死」无法定位。
2. **模板实装留到最后**：先让引擎认识 `characterMedia`，再往模板里写；反过来会一直卡在 `ui_invalid`。
