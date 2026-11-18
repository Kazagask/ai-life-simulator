# 扩展能力占用台账（主包侧）

> **用途**：主包改动时，用这份清单核对会不会打断已装扩展。
> 它是**主包**的文档，不是扩展的私有文档 —— 扩展作者不在这里写自己的玩法细节，
> 那些在 `extensions/family/{doc,spec,test}`。
>
> 当前实例：`@life-sim/ext-family@0.1.0`，声明兼容主包 `^0.1.0`。

## 1. family 用了主包的哪些能力

| 主包能力 | 具体位置（单一事实来源） | family 怎么用 | 改动时的风险 |
|---|---|---|---|
| `ExtensionRuntime` 七钩子 | `packages/game-core/src/v2/extensions.ts` | `relationDerivation` / `snapshotDerivation` / `contributeRelationEdges` / `effects` / `conditions` / `stateSchema` / `onWorldCreated` 全部实现 | 钩子签名或调用时机变化 ⇒ 称谓/族谱静默消失；先跑 `extensions/family/test/*` |
| 扩展注册与解析 | 同上 `registerExtensionRuntime` / `resolveExtensionRuntimes` / `hasExtensionRuntime` / `getExtensionRuntime` | server 启动期注册；模板未声明就不跑 | 注册表口径漂移 ⇒ `unknown_extension` 误报或扩展空跑 |
| 不透明状态切片 | `packages/shared/src/v2.ts` 的 `state.extensions` + `v2-state.ts` 的 `setExtensionStateSliceValidators` | 存 `clans` / `spouses` / `adoptions`，读档期自己校验 | 切片被并入顶层 schema ⇒ 扩展字段无处安放 |
| 指针字段 | `packages/shared/src/schema/character.ts` 的 `fatherId` / `motherId`；`schema/world.ts` 的 `PlayerTemplateSchema` | 亲缘唯一真源；`setIdentity` 效果也能写（开局分主角） | 字段改名 ⇒ 族谱整图丢失 |
| 关系边贡献接缝 | `packages/game-core/src/v2/extensions.ts` 的 `contributeRelationEdges` + `projection.ts` 的合并去重 | 投影期把指针合成亲属边加回关系行，**不写回 state** | 合并顺序/去重键变化 ⇒ 行级称谓消失或重复 |
| 称谓消费 | `packages/rpg-ui/src/NpcCard.tsx` / `NpcDetails.tsx` 的 `RelationList` | 只消费关系行的 `kinshipTerm` 与附加读法，不认识 family 类型 | 关系行契约变化 ⇒ 人物卡崩 |
| 覆盖槽 | `packages/rpg-ui/src/extension-slots.ts` 的 `HOST_UI_SLOTS` / `resolveUiOverride` | 可替换 NPC 卡整体与详情区（family 当前未用，机制保留） | 槽 id 改名 ⇒ 扩展视图不挂载 |
| 追加槽 | 同上 `extensionViewsFor` + `ExtensionView.slot` | 族谱 / 宗族挂 `world.subview` | 槽解析规则变化 ⇒ 页签消失 |
| 版本声明 | `packages/shared/src/version.ts` 的 `satisfiesVersion` / `ENGINE_VERSION` | 扩展声明 `requiresCore`，模板声明 `requires.*` | 版本格式语义变化 ⇒ 老模板误拒载 |
| 测试收集 | `vitest.config.ts` 的 `extensions/**/test/**/*.test.ts` | 13 个用例随根 `pnpm test` 跑 | include 规则收窄 ⇒ 扩展测试静默不跑 |

## 2. 主包需要守住的不变量（来自 `docs/EXTENSIONS.md` §2）

1. 扩展不得覆盖关系行的保留字段（`withId` / `kind` / `visibility` / `direction` / …）。
2. 引擎拥有事实与可见性收敛；扩展只拥有解释。
3. 未声明的扩展一次都不跑；卸载全部扩展后投影逐字段不变。
4. 注册只在启动期；运行期不改。
5. 未知效果类型必须抛 `unknown_effect`，不许静默 no-op。
6. 关系派生必须 memoize（真实翻车：投影 O(n²) 放大）。

## 3. 升级核对流程

1. 改上述任一主包位置 ⇒ 跑 `pnpm test`（含 `extensions/family/test/`）。
2. 若 `ExtensionRuntime` 或关系行契约有破坏性变更 ⇒ 主包 version 进位，
   family 的 `requiresCore` 与新区间对齐，必要时同步 `specs/data/templates/*/world.yaml#requires.core`。
3. 若扩展新增/删除 UI 能力 id ⇒ 同步 `familyExtension.uiCapabilities` 与各模板的 `ui.yaml#place`。
4. 任何"扩展跟不上版本"的情况都应在**加载期**暴露，不允许运行期静默降级。
