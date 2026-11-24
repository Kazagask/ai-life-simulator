# tasks · 角色媒体与技能演出 V1

> 每个 T 都是**可独立验收**的一刀；按 P0 → P4 顺序做，前一波绿了再开下一波。
> 验收命令默认在仓库根执行（沙箱内需关闭沙箱，见 `AGENTS.md`「已知环境坑」）。

## P0 · 协议、指纹、兼容

| # | 任务 | 动哪里 | 验收 |
|---|---|---|---|
| T-01 | 在 `docs/adr/50` / `60` / `70` 补三节：皮肤归身体、媒体与 CutIn 的解析口径、两类指纹与媒体缓存 | `docs/adr/` | 三节各自有「不变量 + 决定 + 被否方案」；`docs/adr/README.md` 无需改（模块内追加） |
| T-02 | 四类 Schema 增量：`CharacterMedia` / `Skin` / `SkinRule` / `CutIn`；`ActorSkinState`；`setSkin` Effect | `packages/shared/src/schema/ui.ts`、`common.ts`、`v2.ts`、`v2-state.ts` | `pnpm typecheck`；新增 `test/unit/character-media-schema.test.ts`（合法/非法各 4 例） |
| T-03 | 指纹拆两套：`semanticFingerprintOf` 排除 manifest；新增 `semanticLegacyFingerprintOf`；存档写入 `assetFingerprint` | `packages/template-loader/src/index.ts`、`apps/web/src/local/*`、`apps/server/src/templates.ts` | 新增 `test/unit/fingerprint-compat.test.ts`：①只改 manifest ⇒ 语义指纹不变 ②旧算法值命中即放行并升级 ③改技能 ⇒ 仍判漂移 |
| T-04 | 加载期校验：`characterMedia` 的 assetId 必须存在；`skinRules[].when` 只放行 time/flag/event 三类；`setSkin` 的 skinId 必须是同角色已声明的 | `packages/template-loader/src/index.ts` | `inspect check` 对三条反例各报一条 error（fixture 放 `test/fixtures/`） |

**P0 出口**：现有 874 例全绿 + 上述新用例绿 + 旧存档样本（`data/worlds/*.json` 中可载入的那些）仍可载入。

## P1 · 资源与缓存

| # | 任务 | 动哪里 | 验收 |
|---|---|---|---|
| T-05 | 建 `assets/manifest.yaml`：登记现有 6 张五条图（`kind: portrait/cg` + `characterRef: npc-gojo`） | 模板 | `/api/templates/jjk-2006/3.0.0/assets/<id>` 返回 200；`inspect check` 0 error |
| T-06 | SW 媒体缓存：`character-media` 缓存、SWR、128 MB + LRU、activate 不清理 | `apps/web/scripts/build-sw.mjs` | 构建产物 `sw.js` 里出现 `character-media`；手动 e2e：二次访问命中缓存，断网仍显示 |
| T-07 | `CharacterAvatar` / `Portrait` 组件 + 文字占位符 | `packages/rpg-ui/src/` | 组件用例：有图渲图、无图渲首字、两者都带 `alt` |
| T-08 | 投影补 `media`：按在场角色（player / npcs / 战斗单位）产出 `avatar.<id>` / `portrait.<id>` | `packages/game-core/src/v2/projection.ts` | `test/unit/media-projection.test.ts`：只产出已登记 asset；未登记 ⇒ 不产出 |

**P1 出口**：人物详情页与叙事气泡能看到五条的头像；断网后仍能看到（第二次访问）。

## P2 · 皮肤与 Self

| # | 任务 | 动哪里 | 验收 |
|---|---|---|---|
| T-09 | 三个解析器（`resolveSkin` / `resolveCharacterMedia` / `resolveCutIn`）+ 槽位回退链 | `packages/game-core/src/v2/presentation/media.ts`（新） | `test/unit/skin-resolve.test.ts`：三级回退、不跨皮肤、未知角色 ⇒ undefined |
| T-10 | `skinRules` 求值（条件子集）+ 优先级链 | 同上 | 用例：`skinId` 覆盖规则；清空后规则生效；时间回溯后回到 student |
| T-11 | `setSkin` Effect：写 `skinId`、`null` 清空、引用校验、投影透传 | `engine.ts` / `common.ts` / `projection.ts` | 用例：写→存读档一致；`null`→恢复自动；越权 skinId ⇒ 加载期 error |
| T-12 | 原作开局皮肤集合：`reuse` 时 `characterMedia[characterId]` 直接可用；自建角色走占位符 | 投影 + 组件 | 用例：`who.reuse=npc-gojo` 时解析出 student；`who.new=player-civilian` 时无媒体不报错 |
| T-13 | 夺舍不改皮肤：`inheritActor` 后 `skinId` 仍在目标身上 | `actors.ts` 不变（靠「不列组」） | 用例：A 夺舍 B ⇒ B 的 skinId 不变；配一条注释说明为什么不能进组 |

**P2 出口**：验收 2/3/4/5/6/7/17 全过。

## P3 · CutIn 与门控

| # | 任务 | 动哪里 | 验收 |
|---|---|---|---|
| T-14 | `SkillCutIn` 组件（立绘 + 技能名 + 进度条 + 点击跳过） | `packages/rpg-ui/src/SkillCutIn.tsx` | 组件用例：渲染 title、`durationMs` 到点回调、点击立即回调 |
| T-15 | `BattleFxLayer` 门控：`cast.seq` 队列、`playedSeqs` 去重、超时兜底（`durationMs + 500`） | `BattleFxLayer.tsx` | 用例：有 cutIn 时 FX 延后；跳过后立即播；卸载后不泄漏 |
| T-16 | 素材选择链：`skillCutIns[skillId] → cutIn → bust → full → 纯文字` | `media.ts` | 用例：四种来源各命中一次 |
| T-17 | 演出不阻塞结算的回归 | `apps/web/src/local/session.ts`（不改，只测） | 用例：cutIn 播放期间 `battleActionV2` 的结果已落 state |

**P3 出口**：验收 9/10/11/12/13 全过。

## P4 · 模板实装与总回归

| # | 任务 | 动哪里 | 验收 |
|---|---|---|---|
| T-18 | 五条三套皮肤（student / teacher / shinjuku）+ 两条 `skinRules`（时间）+ 2 个 `cutIn` | 模板 `ui.yaml` | 游戏内 2006→2017 自动换；`茈` 有 CutIn |
| T-19 | 全链路回归：18 条验收清单逐条过一遍，记录在 `acceptance.md` | — | 18/18 |
| T-20 | 门禁收口：`tsc` / `pnpm test` / `inspect check` / `web build` / 线上冒烟 | — | 四项全绿，`warn` 不新增 |

## 施工顺序上的两条硬规矩

1. **P0 不做完不许动前端**：指纹换算法的窗口只有一次，前后端一起改会让「到底谁把旧档判死」无法定位。
2. **模板实装（T-18）留到最后**：先让引擎认识 `characterMedia`，再往模板里写；反过来会一直卡在 `ui_invalid`。
