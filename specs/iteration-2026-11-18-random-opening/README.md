# 迭代：随机开局 / 前实例化（2026-11-18）

## 一句话

把「开局」从**世界内的事件**改成**世界的生成参数**：一段连续的 n 步混合
roll / choose / allocate 的 branch DAG，在 `commit` 前不实例化世界；抽到什么就 set 什么
参数，self 指向谁就由谁承接基本属性。

## 本轮范围

- **做**：开局参数表（引擎闭集）、前实例化会话、self 完整切换、按 node 派生的 RNG、
  名字可空与开局后改名、jjk-2006 模板用新语法重写。
- **不做**（延续 SPEC §1.4 已裁决）：放弃转盘 / 重抽；`taskDag`；第四种 `settle kind`
  （世界内加点走轮外操作端点，不新增 kind）；模板导入端点；前端 auto 推导能力。
- **DEFERRED**（登记不实现）：自由文本开局行动、多 Agent 开局、flavor 流式输出、
  跨模板验证（仍需第二份真实模板证明需求）。

## 与现行规格的关系

- 权威：`AGENTS.md` + `specs/SPEC.md` + `docs/REFACTOR-NOTES.md`。旧 `specs/iteration-*` /
  `docs/DECISIONS.md` / `PROJECT.md` 已整体归档到 `archive/2026-11-16-pre-rewrite/`，
  **不构成约束**，本目录是新体系的第一轮，不重建旧目录结构。
- 协议级改动（self 存储切换 + 开局会话）按 G2 **先写 ADR**：见 `docs/ADR-001-前实例化开局.md`。
- **状态：2026-11-18 全部实施完成**（T0–T6）。四件套、ADR、内核/服务端/前端、jjk-2006/2.0.0
  模板与天内理子短线均已落地；`pnpm test` 全绿（45 文件 / 275 例），typecheck 与 web build 通过。

## 前置（本轮已落地，不重复做）

YAML branch 的 **node** 支持 `as: <actorId>`：同一 node 别名写多份，各自带不同 `as` ⇒
**同一个节点、不同 self 看到不同正文与选项**（天然互斥；多变体必须有兜底）。
**首节点同样可写 `as`**：多个首节点变体共用父 trigger（"共用触发器、首节点不一样"），
兜底沿用父 id、as 变体用 `<id>#<node>@<as>`；外部 `nextEventId` 指向多变体首节点父 id 时
也按 self 门控展开（random/combat 入边拒载）。
`shared/schema/common.ts` 加 `selfIs` / `selfIsNot` 一等条件、`game-core/engine.ts#checkCondition` 读
`selfIdOf(state)`、`server/templates.ts` 加载期展开变体事件并给 goto / 入边生成同形选项的
self 门控（玩家仍只看到一条选项，不额外占轮次）。LLM 侧 `submitBranch` 不开放 `as`。
**注意**：`selfIdOf` 缺省为 `"player"`；T2 self 完整切换已落地，`as` 运行时随 self 生效。
锁：`test/unit/branch-expand.test.ts`（5 例）+ `test/unit/self-gate.test.ts`（3 例）。

## 给 Agent 的读法

1. 先读 `AGENTS.md` 与 `specs/SPEC.md`，再读本目录 requirements → design → tasks。
2. 一次只做一个 `T<阶段>-<序号>`，按 tasks.md 依赖顺序；改 protocol 前确认 ADR 已通过。
3. 不确定的产品规则写 `docs/OPEN_QUESTIONS.md`（本轮待裁决点见 design §7），禁止自行伪造共识。

## 已裁决（design §7，不再阻塞）

1. self 切换提前为第一步实施（T2）。
2. 只重写开局 13 步 + 加天内理子短线；主线 `source: chain` 保留。
3. `schemaVersion = 5`，v1–v4 旧档拒载（发布时如实告知）。
4. 追加裁决：`status` 进闭集且 commit 时统一获得；`mood` 不入闭集，原开局 `adjustMood` 删除；
   `time` 作为开局时间锚替代旧 `advanceTo`；前端最终面板只展示特质 / 技能 / 物品。
