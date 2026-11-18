# family 扩展 · 实现规范

> 本文件只写**已经落地且可验证**的东西。设计理由与未决项在 `../doc/CLAN-DESIGN.md`
> 与 `../doc/FAMILY-GRAPH.md`；主包视角「本扩展用了主包哪些能力」见
> `../../docs/EXTENSION-CAPABILITIES.md`。
>
> 包名 `@life-sim/ext-family`，版本 `0.1.0`（与 `package.json` 同步），
> 声明的兼容主包区间 `^0.1.0`（`src/index.ts` 的 `requiresCore`）。

## 1. 身份与启用

- 扩展 id = `family`，与模板 `extensions.family` 的键对齐。
- **不声明就不跑**：即使包已装，模板没写 `extensions.family` 时七个钩子一次都不调用。
- 模板若声明 `extensions.family`，就**不许**在 `characters[].relations[]` 里再写亲属边
  （`kinship_conflict` 加载期拒载）；亲缘唯一真源是 `fatherId` / `motherId` 指针 +
  `extensions.family.spouses` 婚配表。

## 2. 七钩子的实际职责

| 钩子 | 做什么 | 不做什么 |
|---|---|---|
| `relationDerivation` | 称谓与多读法（父系优先是硬编码惯例，不读 `descent`） | 不改权威状态 |
| `snapshotDerivation` | 生成 `snapshot.extensions.family`（pedigree + clans） | 不下发 hidden 节点 |
| `contributeRelationEdges` | 投影期把指针合成亲属边加回关系行 | 不写回 `state.relations` |
| `effects` | 宗族效果（`joinClan` 等），只写自己的状态切片 | 不掷骰、不查模板表 |
| `conditions` | 宗族条件 op，模板须声明本扩展才生效 | 不放宽可见性 |
| `stateSchema` | 读档期校验 `state.extensions.family` | 切片缺省时不校验 |
| `onWorldCreated` | 建世界期播种婚配表 / 宗族初值 | 不碰玩家字段 |

`uiCapabilities` 声明 `pedigree` / `clan`，供 `ui.yaml` 的 `place:` 键校验；
前端视图由 `src/ui/views.tsx` 注册到 `world.subview` 槽。

## 3. 状态切片

`state.extensions.family` 的形状由 `src/clan.ts` 的 `clanStateSchema` 定义，
权威字段：`clans[]`（含 `members[]` / `prestige` / `history`）、`spouses[]`、`adoptions[]`。
婚配表在**建世界期播种**，之后所有写点原样保留，不许在切片重建时抹掉。

## 4. 前端契约

- 槽：`world.subview`（追加式页签）、`host.npcCard` / `host.npcDetails`（覆盖式）。
- 视图模型：`FamilyView`（`pedigree` + `clans`），由 `src/ui/adapter.ts` 从不透明切片派生。
- 隐藏端点的边在归一化阶段整条剔除；`PedigreeNodeView.hasCard` 恒为 true，
  前端 `!hasCard` 分支是保留分支而非死代码。
- `ui.yaml` 落位：`pedigree` / `clan` 仅支持 `tab` / `off` / `slot:world.subview`；
  写不认识的槽由前端降级为页签。

## 5. 测试归属

`test/` 在本包内，根 `vitest.config.ts` 的 `extensions/**/test/**/*.test.ts` 会收集；
`pnpm test` 一条命令同时跑主包与本扩展。测试文件不进 npm 包（全部 `private: true`）。

## 6. 版本与兼容

- 世界模板用 `requires.core` / `requires.extensions.family` 声明它按哪版写的；
- 本扩展用 `requiresCore` 声明它兼容哪版主包；
- 三者任一不符 ⇒ 该模板版本加载期 invalid（封闭码 `core_version_mismatch` /
  `extension_version_mismatch`），其它模板照常跑。
- 主包升级前，按 `../../docs/EXTENSION-CAPABILITIES.md` 的清单逐项核对。
