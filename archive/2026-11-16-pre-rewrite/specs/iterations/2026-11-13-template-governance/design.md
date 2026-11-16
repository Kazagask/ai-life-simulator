# R2.8 设计 · ADR-0029 轻量模板治理：模板目录即身份 + 显式版本 + 引用式存档 + 请求驱动热加载

> **本文件 = ADR-0029 草案正文**（Phase 2 产物）。尚未写入 `docs/DECISIONS.md`，待用户确认后由主理人落盘。
> **状态**：草案（待 G1 评审）。**编号说明**：`ADR-0028` 已被「放开用户自带 LLM Key」占用，本轮顺延 **0029**。
> **覆盖**：模板身份（`(目录名, 版本目录名)`）、版本索引、存储布局（`<id>/<version>/`）、存档引用（只记引用、不存字节）、失败哲学（启动期 fail-fast / 运行期隔离）、**运行时热加载**、旧档去向、可扩展模板包（资源 / 未来函数口子）。
> **不覆盖**：模板上传（无端点、无前端入口）、模板市场、账号/owner 隔离、审核、模板编辑器、资源下发、模板字节快照。
> **关联**：ADR-0007（修订决策 3/4/5）、ADR-0010 决策 4（不冲突）、ADR-0025 决策 3 + `BACKLOG B-24`（加红线）、ADR-0026（正交）。`OPEN_QUESTIONS #6 / #15` 建议以本轮结论关闭。
> **锚点纪律（2026-11-13）**：下游 `requirements.md` 的追溯表**只记条目编号（`A-1` / `C-4` / `H-2.1` / `I-3` …），不记本文件行号**。理由：本文件本轮内经过多次增删（删重复段、扩写 C-4、补 H-2.1 与 A-8 留痕），行号漂移过多次，行号写进别处必然过期，**而一个错的行号比没有行号更糟**（会把读者导到错误位置）。**条目编号即权威锚点**；若某编号在本文件里找不到，属于本文件缺陷，应补本文件，不得改需求去迁就。
> **冻结状态**：本稿自 2026-11-13 起**冻结**，只在主理人指令下修改。任何再编辑都必须同步复核编号完整性（尤其 `A-8` 是**空出未复用**的号，见 A 章末）。

> **本轮范围裁决（2026-11-13，用户原话）**：「再砍一板需求 只做读 能选就行 砍掉前端导入模板的口子 但是可以直接改服务端文件 服务端能在运行时热加载就行 运行时丢模板导致报错可容忍（基本不会这么做）」。
> 这一版把上一稿的**上传/导入管线、权限开关、下架/删除守卫全部撤掉**，换成「模板就是服务端目录，改目录 + 热加载」。存档记账方式（只记引用、不存字节）与指纹分层不变。

## 1. 背景

`OPEN_QUESTIONS #6 / #15` 是模板治理母题一直未关。前端已有「多模板」接口形态（`GET /api/templates` 返回数组），后端却把身份硬编码为「目录名 = `meta.id` = 唯一模板」——想加第二个模板或第二个版本，没有任何受支持的路径。用户本轮把范围压到最小：**只做读、能选就行**，模板由人直接放到服务端目录，运行期热加载生效。

三条已验证证据：

1. **身份与索引绑死在 `meta.id`，且无冲突检测**。`apps/server/src/templates.ts:121-133` 遍历目录后 `templates.set(meta.id, …)` / `fingerprints.set(…)`，六个模块级 Map 全按 `meta.id` 索引（`:37-42`）。两目录声明同一 `meta.id` 会**静默互相覆盖**；且没有「版本」这个概念，一个目录只能是一条模板。
2. **指纹是环境派生而非世界事实**。`apps/server/src/store.ts:66` 的 `persist()` 每轮落盘现查 `getTemplateFingerprint(templateId) ?? "sha256:unknown"`；模板一变，下一次保存就把旧档指纹**静默改写**成新模板的指纹，`"sha256:unknown"` 又让这个错误永久不可诊断。
3. **不可载的档在玩家侧静默消失**。`store.ts:96-133` 四关任一不过只 `log.error` 跳过；`GET /api/worlds`（`index.ts:566-606`）只列内存世界 ⇒ 前端 localStorage 留着 `worldId`、点开 404（E-03）。实测 `data/worlds` 65 份：`schemaVersion` 1×8 / 2×57，12 个不同指纹，**仅 8 份与当前 jjk-2006 实时指纹相等**——其中 4 份是 turn 0 的 19.6 KB 小档，即 `cloud.smoke`「每次新建世界」留下的，**这个数会随冒烟自己增长**（见 G-1 的计数纪律）。

## 2. 决策

### A. 身份与版本

**A-1 模板身份 = `(目录名, 版本目录名)`。内置模板与人手放的模板走同一条规则，不存在「内置 / 导入」两个信任域。**
目录形状：`specs/data/templates/<id>/<version>/`，其中 `<id>` 是模板目录名、`<version>` 是版本目录名。身份由**文件系统路径**承载，不由任何清单文件承载。
理由：用户砍掉上传口子后，「服务端生成 id」失去了它唯一要解决的问题（作者自报 id 与注册 id 冲突）。现在的写入口是 `mv`/`cp`/编辑器，能把身份写对的地方只有目录名本身；再引入一层「目录名 ≠ id、靠清单文件映射」只会制造第二真源。同一规则同时覆盖内置与手放 ⇒ 没有「两套信任域」这种解释负担。

**A-2 id 与 version 对玩家可见**（`/api/templates`、世界列表 `templateId` / `templateVersion`、存档信封），它们不含敏感信息；任何 UI 不得把 id 当标题渲染（标题取 `meta.name`）。

**A-3 版本号格式 = 版本目录名，正则 `^\d+(\.\d+){0,2}$`（1–3 段数字，可写 `2` / `1.2` / `1.2.3`）。**
理由：用户对模板的既有叫法是「第二版」，强制三段数字会逼他写 `1.0.0`；1–3 段既保留直觉，又能在补 0 后得到全序（UI 排序、多版本并存都需要序）。
**硬条件**：`2` 与 `2.0.0` 是**不同**版本，服务端**不做等价归一**——归一会让「唯一版本」这件事变成假的。（最终格式仍见 §6 第 1 条。）

**A-4 `version` 不写进 yaml，由版本目录名承载。**
理由一：`meta` 是 `.strict()`（`packages/shared/src/schema/world.ts:142-150`，仅 `id/name/description/startYear/engineProtocol`），加 `version` 字段即 shared schema 变更 = 真 T-2，而本轮一个 shared 字段都不该动。
理由二：版本若由 yaml 决定，「免 ADR 改 yaml」就等于能顺手改掉身份（把人一生挂靠的版本换掉），而改 yaml 是本阶段最高频的动作。

**A-5 新版本的出现方式 = 人往 `<id>/` 下新增一个 `<version>/` 目录；服务端没有任何写入端点。**
理由：既然没有上传口，就不需要「归并到同一 id 的 UX 分叉」——`mkdir` 本身就是归并动作。这也自动满足「先选模板再选版本」：模板列表按 `<id>` 分组、版本列表按 `<version>` 展开。

**A-6 同一 `(id, version)` 只有一条注册记录；内容被就地改动由指纹负责（见 C-3 / I-4），不做幂等/冲突判定。**
理由：没有请求可幂等、没有事务可冲突——磁盘只有一个真相，改就是改。要留旧内容请自己复制一个新版本目录（这也是版本目录存在的意义）。

**A-7 加载期断言 `template.meta.id ≡ <id> 目录名`；这是 `world.templateId` 正确性的唯一保证。**
事实依据：`createWorldV2` 直接写 `templateId: template.meta.id`（`packages/game-core/src/v2/turn.ts:142`），而 `CreateWorldInputV2.templateId` 根本不进状态。所以 `world.templateId` 恒等于 yaml 里那个 `meta.id`；只要断言 `meta.id ≡ <id> 目录名`，就同时得到 `world.templateId ≡ <id> 目录名 ≡ Entry.key` 的 id 段。
- **启动期**：不等 ⇒ `throw`，进程退出（与坏 yaml 同档 fail-fast）。
- **运行期热加载**：不等 ⇒ **跳过该模板 + `log.error`**，保留旧 Entry（若有），不阻断其他模板（见 I-3）。
理由：上一稿靠「服务端 id 覆盖内存 `meta.id`」实现同一目标，现在没有生成 id 了，覆盖就失去对象；改用**断言**更强——它不只让运行时一致，还让「有人在 yaml 里写错 id」在启动期就暴露。**副作用（须知情）**：`world.templateId` 恒等于目录名，因此改目录名 = 让该模板下所有存档找不到模板（见 I-5 的代价声明）。
- **禁止项**：任何路径不得在 `createWorldV2` 之后修改 `template.meta.id`，也不得「临时替换 → 用完还原」——同一 template 对象被该版本所有世界共享（快照共享），改一次全体错位，且错位会以「`templateName` 变了」这种无害外观出现，极难归因。
- **验收断言**：① 建局后 `world.templateId === Entry.ref.id === Entry.template.meta.id` 三者恒等；② 把 yaml 的 `meta.id` 改成别的值 ⇒ 启动期非 0 退出（错误信息含目录名与实际 `meta.id` 两个值）/ 运行期该模板被跳过且 warn，其他模板不受影响。

> **`A-8` 编号空出、不复用**：它原先承载「内置模板不接受追加版本」，随「取消导入端点（A-5 改写）」失去对象而作废。**下游追溯里不应再出现 A-8**，也不要把它改名后重新使用——空号是留痕，复用会让「这条需求当初被砍过」这段历史消失。

### B. 存储与加载

**B-1 目录布局：`specs/data/templates/<id>/<version>/`，内置模板与人手放的模板同一位置、同一规则。**
- 内置 `jjk-2006` 迁入 `specs/data/templates/jjk-2006/1.0.0/`（一次性的目录迁移，见 T-TG-10）。
- **迁移不改指纹**：`semanticFingerprint` 只拼「文件名 + `\0` + 内容」、**不含路径**（H-2.1），而 hash 的输入本来就是版本目录内的 basename 集合——`jjk-2006` 的 11 个 yaml 平移到 `1.0.0/` 后集合逐字节相同 ⇒ 实测 `sha256:9a945ac3…` 不变 ⇒ **现存可载档继续可载**。
- `<id>` 层只允许出现子目录；非目录条目一律忽略 + `log.warn`（见 H-1）。`<version>` 层只允许 `declarative`（`*.yaml`）与 `assets/**`，其余忽略 + warn。
- 不进 `data/`：模板是**随发布走的设计期资产**（`specs/data/` 一直是运行时可读资产目录，`AGENTS.md §0.1` 第 13 行），放进会被 `LIFE_SIM_DATA_DIR` 挂载/清空的运行期目录会导致热加载读到「本地有、部署没有」的模板。

**B-2 不设任何清单文件。目录结构即元数据。**
`_meta.json` 取消：版本信息在目录名上，内容信息在文件本身，指纹实时计算（H-2），可用性由加载结果决定（I-3）。
理由：清单文件会与目录内容漂移（有人改了 yaml 忘了改清单、或反过来），而本轮没有任何写入路径去维护它；「目录即真相」是唯一不会漂移的形态。

**B-3 六个 Map 收敛为一个 `Map<templateKey, Entry>`，`templateKey = ${id}@${version}`**；`Entry = { ref, status: "ready" | "invalid", template, lookup, semanticFingerprint, assetFingerprint, assetCount, openings, endingConfig, evaluationConfig, pipeline, mtime }`（`status:"invalid"` 时只有 `ref / status / reason`）。
对外只暴露 `resolve(ref)`（仅 `ready`）、`listTemplates()`（`ready` 与 `invalid` 都列，后者带 `loadable:false` + `reason`）、`ensureFresh()`（I-1）。
最小改造：`getWorld()` 语义不变，只把「`templates.get(id)` + `lookups.get(id)`」两次查表换成一次 `resolve(ref)`；`pipelineOf(id)` 改读 `entry.pipeline`。涉及 `index.ts` 18 处调用点（`:78,79,112,114,121-130,143-144,208,243,350,363,369,374,570-572,594,598,639`），全部机械替换。

**B-4 失败哲学：按「时机」分两套策略（不再是「内置 vs 导入」两个信任域）。**
1. **启动期 fail-fast**：任一模板 yaml 校验失败、`meta.id` 与目录名不符、`version` 目录名不合 A-3 正则 ⇒ `throw`，进程退出（保留 `templates.ts:66/78/116/134` 的现状口径）。
   理由：启动期能看到的都是「人刚改完还没验证」的东西，让服务带着一个半坏模板起来，等于让所有人玩一个语义不全的世界；此刻炸掉的成本最低。
2. **运行期热加载：单模板隔离，绝不 fail-fast**。重扫失败 ⇒ 保留旧 Entry 并 `log.error`；无旧 Entry ⇒ 该 `(id,version)` 标 `invalid`（可查看、不可新建），不影响其他模板与在跑世界（I-3）。
   理由：热加载把「改坏一个模板」从**提交错误**降级成**运维操作**——炸整个进程的代价与收益不成比例，而且会连坐正在跑的世界。
3. **「空版本目录」不算模板、也不触发 fail-fast**：`<version>/` 内没有任何 `*.yaml` ⇒ 忽略 + `log.warn`（两个时机都如此）；只有「含 ≥1 个 `*.yaml` 但校验失败」才算坏模板（启动期 throw / 运行期 invalid）。
   理由：手放模板的正常动作是 `mkdir 1.1.0 && cp …`——若把「刚建好还没拷完」的空目录当坏模板，运维改到一半重启就把服务搞起不来，而这恰好是本轮唯一的工作流。**这不是放宽校验**：零 yaml 的目录根本不该被当作一个模板版本，它是个占位。
   边界：整个 `specs/data/templates/` 下一个模板都没有 ⇒ 仍然 `throw`（保留既有「没有任何模板就别启动」口径，`templates.ts:134`）。

**B-5 生效范围：新建世界与后续载入用最新 Entry；已载入世界用自己那份内存快照，永不受热加载影响。**
理由见 I-2：运行中改一个 yaml 就让玩家这一局中途换语义，比拒载更糟，且会污染阶段序列、评价证据与历史。

### C. 存档与拒载

**C-1 信封新增 `templateVersion?: string`（可选），`schemaVersion` 保持 2，不升 3。**
理由：升 3 会一次性拒载现存全部可载档，收益为零。代价：读写两侧要容忍「无 `templateVersion`」的过渡期，用 C-2 关掉歧义窗口。

**C-2 缺 `templateVersion` 的档按唯一性推断**：该 `id` 下只注册 1 个版本且指纹相等 ⇒ 采用该版本；0 个 ⇒ `template_missing`；**≥2 个 ⇒ `template_version_ambiguous`**。推断成功则在启动期原子重写信封（回填）。
**判定顺序写死：先定版本，再比指纹。** 因此「该 id 有 2 个版本、且两个都不匹配信封指纹」的归属是 `template_version_ambiguous`——此时根本还没到能比指纹那一步（比也不产生结论：两个都不匹配说明它俩都不是当时那份，但哪一份更近无从判断）。这条已折进 `requirements.md` 的 R-TG-10 AC②（原「§6 待确认 #3」由需求侧关闭）。
**`template_version_ambiguous` 在本轮规则集下是可达分支**：手工放第二个版本目录是受支持的操作（A-5），此后该 `id` 下的旧档（信封无 `templateVersion`）就真的无法判定用哪个版本。**必须作为验收用例**（造一个两版本 + 无 `templateVersion` 的信封 ⇒ 拒载且 reason 为该码），也必须有产品文案（见 §6 第 3 条）。
理由：上一稿靠「内置不可追加」让这个分支不可达；本轮允许手放多版本，它就成了真分支——不能让一个真实存在的状态被写成「不可达」，那是文档级别的自欺。

**C-3 指纹降级为「同 `(id,version)` 的语义内容完整性校验」**：载入基准 = 该版本目录**实时重算的 `semanticFingerprint`**（口径同 H-2.1：只算版本目录根上**白名单 11 个** `declarative` yaml，游离 yaml 不参与）vs 信封 `templateFingerprint`，不等 ⇒ `template_content_drift`。
`assetFingerprint` 与资源存在性**不参与任何拒载判定**（资源缺失或变化只降级展示，见 H-2.3 / H-7）。无清单文件，因此不存在「清单里的指纹」这第三个基准。
理由：基准只有一个才可诊断；资源不该有权力决定一生能不能打开。

**C-4 封闭拒载枚举（服务端 `UnloadableReason`）**：`envelope_json_invalid` / `envelope_schema_version_unsupported` / `template_missing` / `template_version_missing` / `template_version_ambiguous` / `template_invalid` / `template_content_drift` / `world_state_invalid`。
- `template_missing`：`<id>` 目录不存在。`template_version_missing`：`<id>` 在、`<version>` 目录不在。`template_invalid`：目录在但**加载校验失败**（yaml 坏 / `meta.id` 不符 / 版本名非法），即注册表里 `status:"invalid"`。
- `template_invalid` 是本轮新增：热加载让「目录存在但载不动」成为一个正常可观察状态（I-3），不能把它混进 `template_missing`——否则运维会去查「目录怎么没了」而实际目录好端端在那。
- **枚举一共 8 个，一个都不能合并**（`envelope_json_invalid` / `envelope_schema_version_unsupported` / `template_missing` / `template_version_missing` / `template_version_ambiguous` / `template_invalid` / `template_content_drift` / `world_state_invalid`）。其中**模板侧四码必须分列**，合并即失去可诊断性：
  ① `template_missing` = `<id>` 目录没了 → 处置是找回/重建模板；
  ② `template_version_missing` = 版本目录没了 → 处置是放回该版本；
  ③ `template_invalid` = 目录在但校验失败 → 处置是修内容；
  ④ `template_version_ambiguous` = 信封无 `templateVersion` 且 id 下 ≥2 版本 → 处置是补版本号或删档。
  ③④ **尤其不能并进别的码**：③ 并进 ① 会指错方向（去查一个没消失的目录）；④ 并进 ②/`template_content_drift` 在「先定版本、再比指纹」的顺序下**根本到不了**（C-2），会被误当成「内容漂移」，而实际内容可能两份都好好的。
- 映射：`json_parse_failed → envelope_json_invalid`；`schema_version_mismatch → envelope_schema_version_unsupported`；旧 `template_fingerprint_mismatch` 按查表结果细分为上面四种。

**C-5 修 E-03**：世界列表返回「存在但不可载」条目 `{ id, templateId, templateVersion?, loadable:false, reason, savedAt }`；`GET /api/worlds/:id` 对不可载世界返回 409 `world_unloadable` + `reason`（不再 404）；`DELETE` 允许删除不可载世界。
判定：这是**服务端列表接口的新增只读诊断字段**，不动 `packages/shared`、不带 hidden/NPC 私有数据，由本 ADR 覆盖。若 G1 评审认为必须进 shared 类型，则升级为 shared T-2 并重排任务。

**C-6 硬约束：`store.ts:66` 的 `getTemplateFingerprint(templateId) ?? "sha256:unknown"` 必须删除**；`persist()` 一律读 `refs.get(worldId)`，缺 ref ⇒ 抛 `template_ref_missing`（500），**严禁**回落全局查表或占位符。热加载让这条从「防御」变成「必须」——注册表 Entry 会被替换，现查全局表等于把「今天的内容」写进「昨天的存档」。
实现归属：`apps/server/src/store.ts` 新增 `refs: Map<worldId, TemplateRef>`（`{id, version, semanticFingerprint}`），只在两处写入——`create()`（来自 `resolve()` 返回的 Entry，不信客户端字段）与 `loadPersistedWorlds()`（来自信封，含回填）。

### D. 导入管线与安全 —— 整章撤回

**依据本轮用户裁决**：「砍掉前端导入模板的口子」「可以直接改服务端文件」。
上一稿的 D 章（`POST /api/templates/imports` 端点、L1–L6 六层校验、`encoding`/base64、`bodyLimit` 与阈值推导、`LIFE_SIM_ENV` / `TEMPLATE_IMPORT_TOKEN` 鉴权与暴露面分析、D-3「未实测防护不承诺」）**整章失效**：本轮**没有上传入口**，服务端不接收模板字节，因此不存在体积 / 文件数 / 编码 / 鉴权 / 公网暴露这一整类问题。
- 随之失效的错误码：`import_body_too_large` / `import_too_many_files` / `import_file_not_allowed` / `import_file_duplicated` / `import_file_encoding_invalid` / `import_yaml_parse_error`（对外）/ `import_schema_invalid`（对外）/ `import_load_smoke_failed` / `import_code_assets_not_supported` / `import_meta_file_forbidden` / `import_disabled` / `import_token_invalid` / `import_version_conflict` / `import_builtin_version_append_forbidden`。
- **替代物**：模板的合法性判断全部落到「加载期校验」（H-1 角色规则 + `WorldTemplateV2Schema` strict + `superRefine`，`packages/shared/src/schema/world.ts:232-671` 已覆盖跨文件引用完整性），失败表现见 B-4 / I-3。
- **保留的一条**：模板包仍然**不是任意文件堆放区**——角色规则（H-1）改为「加载期识别、非声明/非资源文件一律忽略 + warn」，见 H-1 修订。
- 安全面的变化要说清：本轮唯一能改模板的人是**有服务端文件写权限的人**，威胁模型与「运维能改代码」同级，因此不再需要 token 门禁；但**任何访问者仍然能读到所有人的开局列表**（只读公开），这一点与上一稿一致，不新增暴露面。

### E. 下架 / 删除 / 覆盖 —— 整章撤回

**依据本轮用户裁决**：「运行时丢模板导致报错可容忍（基本不会这么做）」。
上一稿的 E 章（`disabled` 标记、硬删守卫扫信封、`template_in_use` 409、覆盖同版本禁止）**整章失效**：没有 `_meta.json` 可写 `disabled`，也没有 API 可调用；下架 = 把版本目录挪走或改名，删除 = `rm -rf`，覆盖 = 直接改文件。**不做任何引用守卫**——这是用户明确接受的代价，写进 I-5 的后果里，不写进代码。
本条不是「留待将来」而是「明确不做」：需要守卫时，等价做法是先把该版本目录复制备份再动手，成本比一套守卫低。

### F. 与既有决策的关系

| 既有结论 | 处置 | 说明 |
|---|---|---|
| ADR-0007 决策 3（信封结构） | **修订** | 信封变为 `{ schemaVersion: 2, savedAt, templateId, templateVersion?, templateFingerprint, state }` |
| ADR-0007 决策 4（指纹不匹配 → 拒载） | **拒载保留，语义升级** | 从「世界级指纹等值」变为「`(id,version)` 可解析 + 语义内容不漂移」；不再因为「模板变了」同时丢失「变的是哪个模板」 |
| ADR-0007 决策 5（四道关） | **修订** | 第 2 关由 `schemaVersion` 单判断扩为 `schemaVersion` → `(id,version)` 解析（含唯一性推断）→ 指纹 → state schema |
| ADR-0010 决策 4（运行时不生成配置层定义，OQ #46 已裁「不做」） | **保留，不冲突** | 模板只从磁盘读入并校验注册，装载后对象不可变；无任何按 seed 派生定义的路径。热加载是「重新读磁盘」，不是「生成定义」 |
| `AGENTS.md §0.3` 免 ADR 判据 | **不改判据，但补一条口径说明** | glob `specs/data/templates/**/*.yaml` 已覆盖新增的 `<id>/<version>/` 层级，「改 yaml 免 ADR」继续有效；本轮**没有**新的模板写入口，不需要加例外。**补的口径**：模板目录里出现**非 yaml 文件**（`assets/**` 图片、被忽略的 `.js`、散落 `.md`）仍照旧免 ADR——它们对引擎零影响（H-1 忽略 + warn），且**不参与 `semanticFingerprint`**（H-2.1）。反过来：任何会影响可载性的改动必然落在白名单 `**/*.yaml` 里，因此一定被这条判据覆盖。**「放一张图算不算改契约」的答案是「不算」**，判据不必为此加分支 |
| `AGENTS.md §0.1` 第 13 行「`specs/data/` 是运行时资产，禁止移动或改名」 | **需修订一句** | 本轮要把 `jjk-2006` 迁入 `jjk-2006/1.0.0/`，与「禁止移动」字面冲突。建议改为「`specs/data/templates/` 的目录形状由 ADR-0029 规定为 `<id>/<version>/`；其余部分禁止移动或改名」。**更正旧引用**：该条在 `AGENTS.md §0.1`，不在 `PROJECT.md §7` |
| ADR-0025 决策 3 / BACKLOG B-24 | **不解除 + 加红线** | 「模板原文不得上云」范围扩大到手放模板：云端只需 `templateId` + `templateVersion` 就能说清「这局用的哪个版本」，不需要 yaml 正文 |
| `OPEN_QUESTIONS #6` | **建议关闭** | 「不做模板编辑器 / 上传口子；模板 = 服务端目录 `specs/data/templates/<id>/<version>/`，改文件 + 热加载生效；因此**不存在**导入权限模型（无上传面、无 owner、无审核、无配额）。安全边界 = 服务端文件写权限。」 |
| `OPEN_QUESTIONS #15` | **建议关闭** | 「运行时位置 = `specs/data/templates/<id>/<version>/`（与 `specs/data/` 既有约定一致，不新建运行期数据目录）。**支持热加载**：请求驱动（无定时器、无 `fs.watch`），变更检测取「版本目录内文件 mtime 的最大值」（**不用目录 mtime**，就地编辑不改目录 mtime），重扫失败单模板隔离；已在跑的世界走内存快照不受影响。」 |

### G. 旧档代价

**G-1 实测基线（2026-11-13 一次快照；此数会自己变，不可当断言）**：65 份 JSON；`schemaVersion` 1×8 / 2×57；12 个不同指纹；**8 份**与当前 jjk-2006 实时指纹相等（口径 `sha256:9a945ac3…`），其中 4 份是 turn 0、≈19.6 KB 的小档。
**计数纪律（比任何具体份数都重要）**：`apps/server/smoke/cloud.smoke.mjs` **每次运行都会新建世界**（`PROJECT.md §8`），CI 的 L5 每跑一次冒烟就多一份带当前指纹的存档 ⇒ **可载档份数随时间单调增长**。因此：
- 任何**验收判据**一律落在一条不变量上：**迁移是「单向收紧」——原本可载的档迁移后仍可载（可载性只增不减）；原本被误接受或原因粗糙的档，迁移后允许被拒载或被细分（拒绝允许增加）。** 换言之**「接受」不允许增加，「拒绝」允许增加**。判定方式必须是**固化的夹具矩阵逐格比对**（矩阵的规范定义见 `requirements.md` R-TG-10 AC④，迭代归档后随包移动；本 ADR 只固定上述不变量，**不复述矩阵细节**，避免两个真源）；**每格差异必须能归入「新增拒绝」或「原因细分」两类**，否则即回归。**不得**写死份数，也**不得**用「可载档数量不减少」当判据——单份夹具下它恒真，是一条永远不会红的空话；
- 本文件与 `requirements.md` 里出现的份数只作**当次基线快照**，不是断言；
- 夹具必须是**固化样本**：正样本的信封指纹在 setup 阶段按 H-2.1 口径**对当前版本目录实时计算**后写入（**不写死常量**，否则模板一改就假红；「历史指纹该不该被接受」属 C-3，不是本矩阵要测的）；负样本的常量须注明「**故意不匹配**」；**一律不得从 `data/worlds` 任取样本**（该目录会随冒烟增长、也会被手工增删）。

**G-2 本轮后去向**：现存可载档（G-1 快照为 8 份）经 C-2 回填后**仍可载**（`jjk-2006` 目录下只有 `1.0.0` 一个版本，唯一性推断成立）。**目录迁移到 `<id>/<version>/` 不改变语义指纹**（A-3 / B-1 / H-2.1：hash 只用 basename 集合，路径不进 hash），因此迁移本身不会让这批档掉出去——这一条已实测，不是推断。
其余档仍不可载，但**从启动日志的一行**变成列表里可见、可删、带封闭 reason 的条目。净变化：**可载数不减少**，**可诊断数 → 全部档**。

**G-3 不抢救（与用户倾向一致）**，证据性判断：① 12 个指纹来自同一目录的历史内容，`git log -- specs/data/templates` 只有 28 个提交，理论上能找回部分 yaml；② 但「模板一样」≠「人生可复现」——同期引擎侧改过终止模型（ADR-0004）、槽模型（ADR-0026）、投影与评分（ADR-0017）、NPC 生命周期（ADR-0020/0021），仅恢复 yaml 无法复原当时语义（**基于 ADR 清单推断，未逐档实测**）；③ 用户已裁决不要求可复现。

**G-4 可载档不会因本方案减少**：现存可载档的 `id` 都是 `jjk-2006`，迁移后该 id 下只有一个版本 ⇒ 唯一性推断恒成立、回填必成功。
**但结论的性质变了**：不再是「结构上不可能出现多版本」（本轮允许手放多版本，A-5），而是「**当前**只有一个版本」。因此这是一条**当下成立、可被一次 `mkdir` 打破**的结论——打破之后的正确表现是 C-2 的 `template_version_ambiguous`（可诊断），不是静默选错。这比上一稿的「结构保证」弱，但那是本轮回退「无导入端点」换来的必然代价，必须如实写明。
**残留风险：部署回滚**。回填后回退到旧二进制，旧代码忽略多出来的 `templateVersion` ⇒ 档仍可载，但下次保存会写出不含该字段的信封，回填丢失。处置：再前进一次即重新回填（幂等），记进运维说明；不做双向兼容代码。

**G-5 确定性影响**：同 seed + 同输入 + 同 `(id, version, semanticFingerprint)` ⇒ 同结果，**不变量成立**（引擎零改动；模板对象装载后不可变；已载入世界用快照隔离，热加载不改变它）。跨 fingerprint 不做承诺（用户裁决：可复现只在迭代测试中保证）。确定性边界的载体从「全局指纹表」改成「世界固化 ref + 内存快照」。

### H. 可扩展模板包（非 yaml 资源 + 未来函数口子）

> 用户裁决（2026-11-13）：「模板可能不只是 yaml 也可能是资源，甚至后期会开自定义函数的口子，本次保留扩展性」。
> 本章只做**扩展性预留**，不含任何「本轮可用」的能力——凡不可用的逐条写明不可用在哪。**本轮变化**：没有上传面，因此角色规则的处置从「拒绝」改为「忽略 + warn」（手放文件的人自己负责，且没有任何人能通过接口往别人机器上塞文件）。

**H-1 文件角色规则**：包内每个文件按**相对路径**归入一个角色（正则/前缀，零依赖）。

| 角色 | 路径规则 | 本轮处理 |
|---|---|---|
| `declarative` | `<version>/` 根**平铺**：`world/characters/skills/items/statuses/events.yaml`（必需）+ `equipment/combat-ai/opening/endings/evaluation.yaml`（可选） | 合并后进 `WorldTemplateV2Schema`（strict）+ 三域可选 schema；进 `semanticFingerprint`；**校验失败 ⇒ 该模板 invalid**（B-4 / I-3） |
| `asset` | `<version>/assets/` 子树内任意相对路径，允许任意扩展名，**但可执行/可载入类型一律忽略**：`.js .mjs .cjs .ts .jsx .tsx .wasm .node .so .dll .dylib .exe .bat .ps1 .sh .html .htm .svg` | **存在即计入 `assetFingerprint` / `assetCount`；引擎不消费、前端不下发**（H-7）。被禁扩展名 ⇒ **忽略 + warn**，不阻断 |
| `code`（其余一切） | `<version>/` 下非上述路径（含 `assets/` 外的子目录、任意非 yaml 文件）、`<id>/` 层的非目录条目（如残留的 `*.wheel.json`） | **忽略 + `log.warn`**，不参与指纹、不参与校验、不进注册表。**不存在拒绝语义**——本轮无上传面，拒绝没有对象 |
| ~~`meta`~~ | ~~`_meta.json`~~ | **角色删除**：R4 取消清单文件。若有人手放同名文件，按 `code` 处理（忽略 + warn） |

理由：11 个固定文件名 + 禁子目录的规则在「有资源」之后立刻失效（资源必然在子目录）。按路径给角色把「哪些进引擎、哪些只是放着」从文件清单变成**可穷尽的分类——没有第 5 类**。
`.svg` / `.html` 不做为资源使用：它们是可执行内容的载体（脚本、外链、XSS），而本轮**没有任何下发端点**能消毒。将来要支持，必须连同下发端点与消毒策略一起走 ADR，不能「先放进来以后再说」。
`declarative` 必须**平铺在版本目录根**、不改子目录：`computeFingerprint` 与 `loadTemplate`（`templates.ts:101-112`）按根平铺工作，改形状 = 改历史指纹口径 = 自伤 现存可载档。
**为什么从「拒绝」改成「忽略」**：拒绝的意义是「挡住不可信输入」，而本轮输入面只有文件系统本身。此时把「忽略 + 响亮告警」作为默认，比让服务起不来更符合 B-4 的运行期策略；但**告警必须是 warn 且带路径**，否则「文件放了但没生效」会变成一次无声的调试事故。

**H-2 指纹分层（全部实时计算，不落盘——R4）**
- **H-2.1 `semanticFingerprint` = 版本目录根上**白名单内的 11 个 `declarative` 文件名**（`world/characters/skills/items/statuses/events` + `equipment/combat-ai/opening/endings/evaluation`）**按文件名排序，拼接 `文件名 + "\0" + 内容`（**不含路径**）后 sha256；目录里**游离的非白名单 yaml 不参与指纹**。
  依据（实测）：`jjk-2006` 目录**恰好只有这 11 个 yaml**，因此「按白名单取」与现状「取全部 `*.yaml`」得到**同一组输入** ⇒ `sha256:9a945ac3…` 逐字节不变 ⇒ 现存可载档继续可载、目录迁移零成本（路径不进 hash）。对照：若把非 yaml 一并纳入（含 `.wheel.json`）= `sha256:1b3ff034…`，不等 ⇒ 改全量会在启动瞬间把现存可载档全部打成 `template_content_drift`。
  **为什么对「游离 yaml」收紧（这是对现状的一处有意偏离）**：现实现 `computeFingerprint` 用 `readdirSync(dir).filter(f => f.endsWith(".yaml"))`，会把**任何**散落的 `notes.yaml` 都算进指纹——而这类文件按 H-1 根本不参与加载。结果是一条最坏路径：**加一个备注 yaml（免 ADR、不改任何语义）就把全部旧档砖掉**。既然它在加载期被忽略，它在指纹里也必须被忽略；**「被忽略的东西不该有让存档失效的权力」**。
  无白名单文件时不特判：一个版本目录若连 6 个必需 yaml 都没有，它本来就会被 schema 校验拒掉（B-4），轮不到指纹说话。
- **H-2.2 `assetFingerprint` = `assets/**` 按相对路径排序，拼接 `相对路径 + "\0" + 内容` 后 sha256；无资源时取空输入 sha256 常量**（`sha256:e3b0c442…b855`）。
  理由：空集必须有确定值而非 `undefined`，否则「同一个包在不同机器指纹不同」会从空集长出来。
- **H-2.3 载入判据只看 `semanticFingerprint`**；`assetFingerprint` 只用于资源新鲜度诊断与缓存键。资源缺失或变化 ⇒ **只降级展示（图裂/静音），世界照常可载**。
  理由：改一张立绘就让人一生不可载，是「引用式快照」最疼的地方。**模拟可载性与展示完整性必须解耦**，否则存档寿命会被最不重要的文件决定。

**H-3 无清单文件 ⇒ 扩展点落在角色表上**
本轮只有角色表这一个扩展点。未来放开函数 = 给角色表加一个 `code` 的可执行子类 + 加一个执行器 + 改指纹口径（H-6 第 3 条），**不动目录布局、不动存档结构**。
代价要说清：没有 `files[]` 清单意味着「这个包到底有哪些文件、哪个版本是谁给的」只能靠 `ls` 与 git；本轮接受（无上传面，作者就是运维）。

**H-4 加载顺序（替代原 L3 的顺序要求）**：**先判角色（纯字符串、零 IO），再读内容**。角色判定必须排在读取之前，否则一个 100 MB 的无关文件会先被读进内存才发现不该读。

**H-5 传输格式**：**整节失效**——没有上传，不存在 `files[]` / `encoding` / base64 / `bodyLimit`。文件如何编码由文件系统决定，与引擎无关。

**H-6 自定义函数 seam：不是「留空位」，是「禁止 + 四条前置」**
本轮 `code` 类文件一律**忽略**（不加载、不执行），服务端**不存在**任何 `eval` / `new Function` / `vm` 调用路径。放开的前置条件（缺一不可，与 R3 seam 同型）：
1. **必须在服务端沙箱执行**（独立进程/worker + 内存与 CPU 上限 + 硬超时）；**不得在主进程 `eval`/`new Function`/`vm`**——`node:vm` 不是安全边界（同进程、可逃逸），把它当沙箱是本类设计最常见的错误。
2. **不得进 `packages/game-core`**（`AGENTS.md §1`）：只能在 `apps/server` 编排层做「候选 / 叙事 / 装饰」，不得写权威状态、不得决定评分。
3. **必须进 `semanticFingerprint`**（代码即语义，改了必须拒载），且存档要能记录「本局用了哪个代码版本」（届时信封加可选字段，属 T-2）。注意这会**改变指纹口径**，必须同一次 ADR 里定完，不能分两步。
4. **独立 ADR + G2 评审**；放开时同步补「代码变更 ⇒ 旧档不可载」的验收用例。
> **「保留扩展性」≠「留一个能塞代码的入口」**——一个能被塞代码又没人看的入口（尤其在热加载下会被反复扫描）就是将来的远程代码执行面。

**H-7 资源下发 seam：明确 DEFERRED（本轮资源「放得进、用不上」）**
必须显式写死：本轮**没有**任何 schema 字段能引用 `assets/`（实测 `packages/shared/src/schema/*.ts` 对 `assets`/`asset` 零命中）、**没有**下发端点、前端**不接收**资源。手放的图片与音频在本轮的唯一可观测效果是 `GET /api/templates` 里多出 `assetCount` / `assetFingerprint`——**它不会出现在游戏里**。
未来要做必须同时定三件事，且与本 ADR 分离：① schema 引用字段（T-2）；② 下发端点（鉴权、缓存、`Content-Type` 白名单、消毒）；③ 投影契约（T-2）。理由：一个能按路径下发任意文件的端点 = 匿名 CDN + XSS 面，**不是「顺手加的静态文件路由」**。

**H-8 与 C-3 的关系**
- 载入判据唯一：磁盘重算的 `semanticFingerprint` vs 信封 `templateFingerprint`；不等 ⇒ `template_content_drift`。**asset 变化或缺失不触发任何拒载。**
- **信封字段名保持 `templateFingerprint` 不变**：现存可载档里记的就是这个 key，改名等于给旧档加一道「读不到字段」的墙。语义以本 ADR 为准：`templateFingerprint` ≙ `semanticFingerprint`。
- **`assetFingerprint` 不进信封**：进信封等于承诺「资源也可复现」，与 H-7 的 DEFERRED 矛盾；且会让「换一张立绘」表现为信封字段变化，制造「存档被改过」的假象。

### I. 运行时热加载

**I-1 触发方式：请求驱动，无定时器、无 `fs.watch`。**
`resolve(ref)` / `listTemplates()` 前调用 `ensureFresh()`：对每个 `<id>/<version>` 取 **「该版本目录内所有文件的 mtime 最大值」**（顶层 `*.yaml` + `assets/**` 递归），与缓存值比对；**只有变化的版本**才重扫、重新校验、替换 Entry。
**硬约束：不得用目录 mtime 代替。** 就地编辑一个已存在的文件（改 `events.yaml` 内容）**不会改变其父目录的 mtime**（目录 mtime 只在增删改名前项时变），只 stat 目录会漏掉最常见的那种改动——那正是需求 R-TG-16 AC① 要验的场景。
理由：`fs.watch` 在 Windows / Docker volume / NAS 挂载上丢事件是常态（这些正是本项目实际的部署形态）；定时器为空转付电费，且给不了「改完立刻生效」的确定感；请求驱动是零后台任务、行为可预测。
成本上限（算给你，别靠感觉）：每请求 ≤ 11 次（顶层 yaml）+ ≤ 32 次（assets）`stat` = **≤ 43 次**，单机亚毫秒级；这比「每次请求重新解析 257 KB yaml」便宜两个数量级，也解释了为什么必须有 mtime 缓存而不是全量重扫。
**已知局限（写清楚，别让人以为是实时）**：mtime 精度差（某些文件系统 1–2 秒）与「编辑后立刻请求」的竞态会导致**最多晚一次请求**看到变更；这是可接受的，因为改模板的人会自己刷新验证。

**I-2 生效范围：内存快照隔离。**
每个已载入世界在 `worldStore` 里持有自己的 `{ state, template, lookup, entry }` 快照；**热加载替换注册表 Entry 不改变已载入世界**。新建世界与后续载入使用最新 Entry。
理由：否则运行中改一个 yaml，玩家这一局就会在中途换语义——比拒载更糟，且会把阶段序列、评价证据、历史全部污染，而这些是「同 seed 同结果」的地基。快照隔离是唯一能让「热加载」和「确定性」共存的做法。
实现要点：`worldStore` 内部记录从 `WorldStateV2` 扩为 `{ state, entry }`；`getWorld()` 从记录里取 `entry`，不再每次按 `templateId` 反查注册表。这与 C-6 的 `refs` 是同一份记录的两面，**合并成一条 record**，不要开两个 Map。

**I-3 失败策略：运行期单模板隔离，绝不 fail-fast。**
重扫失败（yaml 坏 / `meta.id` 与目录名不符 / 版本目录名不合 A-3 正则）⇒ 保留旧 Entry（若存在）并 `log.error`（带路径与首个 issue 路径）；**无旧 Entry** ⇒ 该 `(id,version)` 标 `status:"invalid"` + `reason`，在 `listTemplates()` 里以「可查看、不可新建」呈现，不影响其他模板与在跑世界。启动期仍 fail-fast（B-4）。
**空版本目录（无任何 `*.yaml`）在运行期同样只是忽略 + warn**，不产生 `invalid` 条目——否则一次 `mkdir` 就会在列表里挂出一条「不可用」的假模板（B-4 第 3 条）。
理由：热加载把「改坏一个模板」从提交错误变成运维操作，炸进程的代价与收益不成比例；而「静默保留旧 Entry」比「静默接受坏内容」安全得多——它保证引擎永远只跑一份**通过完整校验**的模板。

**I-4 同一 `(id,version)` 内容被就地改动：新 Entry 顶替旧 Entry。**
旧世界继续用内存快照；该世界下次**重启载入**时，磁盘重算 `semanticFingerprint` 与信封不符 ⇒ `template_content_drift`（可诊断、不静默）。已在内存里的世界不会因为热加载而失败。
这是「引用式存档」的固有代价，用户已接受。**说明**：本方案下「改内置模板 yaml」的后果与上一稿完全一样（旧档拒载），变化只是**不需要重启**就能让新模板对新局生效。

**I-5 模板目录被删 / 改名：注册表移除该 Entry。**
已载入世界继续跑（内存快照）；重启后载入失败 ⇒ `template_missing`（目录删）或 `template_version_missing`（版本目录删）。世界列表标记为不可载、可删。**不做任何引用守卫**（用户裁决）。
代价声明（必须留在文档里）：**改目录名 = 让该模板下所有存档找不到模板**（A-7 使 `world.templateId` 恒等于目录名）。想在保留存档的前提下换名字，只能复制目录再让旧目录留着。这条不需要代码守卫，但需要一句人话，否则某天一定会有人 `mv` 完发现全世界存档都打不开。

## 3. 被否决的备选

| 备选 | 否决理由 |
|---|---|
| **保留模板上传端点 / 前端导入口子** | 用户本轮明确砍掉（「只做读 能选就行 砍掉前端导入模板的口子」）。保留它要连带体积/编码/鉴权/公网暴露一整章规则，而它的价值已被「直接改服务端文件」覆盖 |
| 内容寻址快照库（存模板字节副本，按 hash 载入） | 用户已裁决「引用即可」；存档中位 36 KB vs 模板 yaml 257 KB，按当前 65 份存档估算各带一份 ≈ 存储放大 9 倍（估算，非实测中位数）；更要紧的是它把「可复现」伪装成承诺，而引擎仍在改（ADR-0020/0021/0026），字节一样也复现不出当时语义 |
| 存档内嵌模板字节 | 同上，且直接撞 ADR-0025 决策 3「模板原文不得上云」 |
| 公开模板市场 | 用户明确不做；隐含 owner、审核、举报、排序四套机制，与「轻量」相反 |
| 按指纹作身份 | 改一个错别字就变成「另一个世界」，且按 id 反查的调用点全部失效 |
| **指纹改成「目录全量 hash」**（把非 yaml 文件一并纳入） | 看似更严格，实测会把 现存可载档一次性打死：yaml-only 与全量两个 hash 不等。正确解法是按语义分层（H-2），不是扩大指纹覆盖面 |
| **指纹里带路径**（把相对路径也拼进 hash） | 与本轮目录迁移直接冲突：`jjk-2006/*.yaml → jjk-2006/1.0.0/*.yaml` 会改掉 现存存档的指纹。语义身份只该由内容和文件名决定 |
| **用 `fs.watch` 或定时器驱动热加载** | Windows / Docker volume / NAS 挂载丢事件是常态；定时器空转付电费。请求驱动零后台任务且可预测（I-1） |
| **每次请求全量重扫所有模板**（不做 mtime 缓存） | 现在是 1 个模板 1 个版本，全量重扫也只多几毫秒，但它会随模板数线性变成每次请求解析全部 yaml（`events.yaml` 单文件 173.8 KB）。mtime 缓存把成本钉在「变更时付一次、平时只 `stat`」 |
| **运行期也 fail-fast**（重扫失败就退进程） | 热加载让坏模板成为运维态而非提交态，炸进程会连坐所有在跑世界（I-3） |
| **热加载直接替换在跑世界的模板** | 一局中途换语义会污染阶段序列、评价证据与历史，破坏「同 seed 同结果」的地基（I-2） |
| **在角色表里给 `.wheel.json` 加 legacy 例外** | 一个枚举位换一条永久例外，正好抵消 H-1「没有第 5 类」的价值。新布局下它落在 `<id>` 层，天然归 `code`（忽略 + warn）（T-TG-10） |
| 升 `schemaVersion` 到 3 | 一次性拒载现存全部可载档，收益为零 |
| `version` 写进 `world.yaml` 的 `meta` | `meta` 是 `.strict()`，加字段 = shared T-2；且让「免 ADR 改 yaml」能改身份 |
| 用清单文件（`_meta.json`）承载版本与指纹 | 两个真相必然漂移，而本轮没有任何写入路径去维护清单；目录名 + 实时计算已经足够（B-2 / R4） |

## 4. 后果

### 4.1 影响面

| 改动点 | 归属 | T-2 | 写冲突 |
|---|---|---|---|
| 目录化注册表：扫描 `<id>/<version>/`、`Map<id@version, Entry>`、`status: ready\|invalid`、`resolve`/`listTemplates`、`ensureFresh()` + mtime 缓存、双指纹实时计算、角色表识别、`meta.id ≡ <id>` 断言 | `apps/server/src/templates.ts`（重写，约 156 → 300 行） | 否 | 与任何改 `templates.ts` 的任务冲突，单人连做 |
| **`worldStore` record 结构：`{ state, entry }` 内存快照 + `refs` 固化（含 `semanticFingerprint`）** | `apps/server/src/store.ts` | **是（存档结构）**，但 `packages/shared` 零改动（`StoreEnvelope` 是服务端私有 interface，`store.ts:39-45`） | 与 B-24 类改动冲突（B-24 仍 DEFERRED）；与 `templates.ts` 同一批改（record 类型要共用） |
| 信封加 `templateVersion?`、`persist` 去全局查表、启动期回填、`UnloadableReason`（含新增 `template_invalid`）、不可载条目收集 | `apps/server/src/store.ts` | **是（存档结构）** | 同上 |
| 18 处调用点收敛、`getWorld` 返 record、`pipelineOf` 改读 `entry.pipeline`、`POST /api/worlds` 版本校验（唯一版本隐式 / 多版本 400）、世界列表 `loadable/reason` | `apps/server/src/index.ts` | 列表增字段由本 ADR 覆盖（C-5） | 与 ADR-0028 同文件不同区段；注意 `:32` import 与 `:78-79` |
| 模板 → 版本两级选择、`openings` 归属修正（`main.tsx:680` 的 `templates[0]?.openings`） | `apps/web/src/main.tsx`、`api.ts`（`TemplateSummary:56-66`、`createWorld:143`） | 否 | 与前端其他任务易冲突，独占一轮。**不再有导入 UI** |
| 目录迁移：`jjk-2006/*.yaml → jjk-2006/1.0.0/*.yaml`（+ 可选把 `*.wheel.json` 移出到 `specs/data/references/`） | `specs/data/templates/**` | 否（纯移动，`semanticFingerprint` 不变） | 独立一次性提交，排在所有代码改动之前（T-TG-10） |
| **零改动** | `packages/shared/**`、`packages/game-core/**` | — | — |
| 文档：`AGENTS §0.1` 第 13 行修订一句、`ARCHITECTURE.md` 目录说明、`OPEN_QUESTIONS #6/#15` 关闭、`DECISIONS.md` 落 ADR-0029 | `docs/*`、`AGENTS.md` | 否 | 由主理人在用户确认后执行 |

### 4.2 旧档
见 G-2 / G-4：**可载数不减少**、可诊断数 → 全部档；不可载档不抢救但可见、可删、带原因。**目录迁移不改语义指纹**（H-2.1 不含路径），迁移本身不会让现存可载档掉出去。

### 4.3 确定性
引擎与 `packages/shared` 零改动 ⇒ 内核确定性不受影响。承诺边界收紧并显式化：确定性只在同一 `(id, version, semanticFingerprint)` 内成立；存档不再承诺「终身可载」，模板或版本不在即拒载（已接受代价）。**热加载不削弱确定性**——因为已载入世界走内存快照（I-2），模板对象在一次世界生命内恒定。

## 5. 不变量检查表

| 不变量 | 现状 | 影响 | 保护措施 |
|---|---|---|---|
| 同 seed 同输入同结果 | 成立 | 不受影响（引擎零改动；模板对象装载后不可变） | 保留 `playthrough.test.ts` 6 种子 × 2 开局；断言同 `(id,version,semanticFingerprint)` 两次建局逐字段相等 |
| **热加载不污染在跑世界** | 新增不变量 | 受影响（新增热加载） | ① `worldStore` 记录持有 `{state, entry}` 快照，`getWorld()` 不再按 `templateId` 反查注册表；② 断言：建局 → 改 yaml + 触发 `ensureFresh()` → 该世界后续 3 轮快照与未改时逐字段相等；③ 同时断言「新局用新 Entry」 |
| hidden 不进入玩家端 API | 成立 | 受影响（列表新增 `reason`；模板列表新增 `versions[]` / `assetCount`） | 字段白名单：仅 `id/version/name/description/startYear/openings{id,name,description}/loadable/reason/assetCount/savedAt`；断言不含 NPC `private`/`secrets`/ending `narrativeConfig` 原文 |
| **目录名 ≡ `meta.id` 断言不改变玩家可见投影** | 成立 | 受影响：A-7 把「覆盖 `meta.id`」改成「断言 `meta.id ≡ 目录名`」，而 `/api/worlds` 的 `templateName` 取 `template?.meta.name`（`index.ts:594`）、`formattedTime` 取 `createTimeAdapter(template).format(...)`（`index.ts:598`） | ① `Entry.ref.id === entry.template.meta.id` 单测；② 断言同一世界在模板重载前后 `templateName/formattedTime/status/endingTitle` 逐字段不变；③ 投影层不得读目录路径或 `meta.id` 以外的身份字段 |
| 世界观规则只进模板 | 成立 | 不受影响 | 注册表只做「装载 + 校验 + 索引 + mtime」，不得对模板内容做世界观判断 |
| 时间/随机/ID 可注入 | 世界 id 用 `randomUUID`；指纹纯函数 | 不受影响（本轮**取消**了服务端生成模板 id，不再新增随机源） | 内核 `rng` 路径不动；世界 id 生成方式不变 |
| 归档只读 | 成立 | 受影响（启动期回填会重写已归档世界文件） | 回填**不走** `worldStore.save()`（是信封迁移不是状态写入），只加字段；断言回填前后 `state` 深比较相等且 `archived` 仍为 true |
| R3 时间穿越 seam | 三个 seam 存在 | 不受影响 | 不触碰 `TimeAdapter`/可见性投影；版本标识反而给事件实例标识一个更强锚点 |
| **模板身份只由语义内容决定**（可载性不被展示资源绑架） | 成立（指纹只算根平铺 yaml，不含资源、不含路径） | **受影响**：新增 `asset` 角色与分层指纹；误改为目录全量 hash 或在 hash 里带路径，都会把 现存可载档打成 `template_content_drift`（实测两个 hash 不等） | ① `semanticFingerprint` 口径冻结为 H-2.1（**白名单 11 个 + 不含路径**；对当前模板其结果与 `templates.ts:101-112` 逐字节一致，但**实现必须改**：现实现的 `filter(f => f.endsWith(".yaml"))` 会把游离 yaml 算进指纹）；② 载入只读 `semanticFingerprint`（C-3）；③ 回归断言「只改 `assets/` ⇒ 现存可载档仍可载」「目录迁移 ⇒ 指纹不变」「放一个游离 `notes.yaml` ⇒ 指纹不变」（R-TG-15 AC③） |
| **确定性内核零动态代码**（`AGENTS §1` / §5） | 成立（`game-core` 无 LLM / 网络 / `eval`） | **受影响**：用户提出「后期开自定义函数口子」，且热加载会**反复扫描**目录 | ① `code` 类文件加载期**忽略 + warn**，不进注册表、不进指纹、不执行；② 服务端不存在任何 `eval`/`new Function`/`vm` 路径；③ 四条前置写进 H-6 |

## 6. 已裁决（2026-11-13）

> **两条均已经用户裁决：① 版本号格式 = B（1–3 段数字）；② 歧义口径 = A（报错要求手工补填）。**
> 本节保留候选与后果以备复审；正文（A-3 正则 / C-2 判定顺序）已按 B / A 书写，无需再改。

> **已随裁决 R1 关闭、不再问**：内置 `jjk-2006` 迁入 `specs/data/templates/jjk-2006/1.0.0/`。目录形状由 R1 定，语义指纹不变（已实测），现存可载档不受影响。**唯一连带待办是文档修订**——`AGENTS.md §0.1` 第 13 行「`specs/data/` 是运行时资产，禁止移动或改名」需改一句（见 F 表），并入主理人落盘时的文档批次，不占用户裁决。

1. **版本号格式**（**✅ 已裁决 B**）：A 三段纯数字 `^\d+\.\d+\.\d+$` / **B 1–3 段数字 `^\d+(\.\d+){0,2}$`** / C 自由字符串。
   后果：A 逼「第二版」写成 `2.0.0`，最一致但最啰嗦；B 兼容「第二版 → `2`」，代价是 `2` 与 `2.0.0` 必须是**不同**版本（不做等价归一，否则唯一性是假的），UI 需并排显示、按补 0 后全序排序；C 引入「`2` 和 `第二版` 谁更新」的无解排序，不推荐。
2. **`template_version_ambiguous` 重新成为可达分支后的产品口径**。
   触发条件：某 id 下被人放了第二个版本目录之后，旧档（信封无 `templateVersion`）无法判定用哪个版本。
   候选：**A 保留该 reason、世界在列表里显示「模板版本未知，不可载入」，由人手工在信封里补 `templateVersion` 或删档**〔建议，可诊断、不静默〕/ B 多版本时默认取最高版本（会**静默选错**，把玩家的另一条人生线当成这条打开，不可接受但列出）/ C 回填时按指纹匹配猜测版本（命中率取决于内容差异，猜错后果同 B）。
   **✅ 已裁决 A。** 理由是本轮已经把「丢模板导致报错」列为可容忍代价，那么「多版本以致歧义」也应显式报错，而不是替玩家猜。

## 7. 任务拆分

见 `tasks.md`。**本轮需重排**（该文件尚未同步，属主理人／实施工程师的事项，本稿不改它）：
- **删除**：导入端点 / L1–L6 / 鉴权开关 / 下架删除端点 / 前端导入 UI 相关任务。
- **新增**：`ensureFresh()` + mtime 缓存 + 单模板隔离（I-1/I-3）、`worldStore` record 快照（I-2）、`template_invalid` 分支与列表呈现。
- **扩写**：`T-TG-10` 从「移出 `.wheel.json`」扩为「目录迁移 + 移出 `.wheel.json`」，且**必须排在最前**（纯移动、指纹不变，先落地可让后续代码改动直接按新布局写）。

---

> **本稿为 ADR-0029 草案**，未写入 `docs/DECISIONS.md`。本次修订只改 `design.md` 一个文件，未动 `requirements.md` / `tasks.md` / `README.md`，未改任何代码。
