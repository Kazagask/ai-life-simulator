# 旧机合并守则 · 搬代码时守住自己的那几次迭代

> **给谁看**：在崩溃后恢复的那台机器（下称**旧机**）上操作的人，或旧机上新开会话的 Coding Agent。
> **自包含**：本文不依赖本对话上下文、不依赖旧机网络。单独把这一个文件拷过去也能用。
> **配套**：新副本侧的合并概要与合并指示见 `docs/RECOVERY_MERGE.md`。
> **建立**：2026-11-13 23:45 ｜ 分支 `recovery/merge-2026-11-13` ｜ 基线 `main @ 8e4b4f7`。

## 0. 一句话（请先看这一行）

**旧机上那几轮迭代是权威成果，新分支后续写的代码只是「后来补的增量」。搬运方向只能是「把新分支的提交以 patch / cherry-pick 叠到旧机」，永远不要用新分支或 `main` 覆盖旧机工作目录。**

原因很实在：GitHub 远端目前只有 `main @ 8e4b4f7`（只到 R2.7 / ADR-0027），**旧机那约两个大版本根本不在远端**。一旦在旧机上删目录重新 clone、`reset --hard`、整目录覆盖，那些代码就真的没了，远端救不回来。

## 1. 先认清两侧，别搞反

| | 新副本（这边） | 旧机（你那边） |
|---|---|---|
| 来源 | 2026-11-13 23:23 全新 clone | 崩溃前一直在用的工作目录 |
| 进度 | `main @ 8e4b4f7`，167 commits，R2.7 / **ADR-0027** | 约**两个大版本**，ADR 推进到 **~0032** |
| 分支 | `recovery/merge-2026-11-13`（目前只有文档提交 `761e8c2`，**后续会继续写实现代码**） | 可能有未 commit / 未 push 的在飞工作 |
| 独有资产 | 版本缺口核查、合并指示、本守则 | ADR-0028..~0032 正文、四项玩法改动、`.workbuddy/memory/`、`data/worlds/`、未跟踪脚本、验收报告 |
| 契约面 | 旧口径：`pendingEvents` 串行化守卫、ADR-0026「槽模型转正」 | **新口径**：`pendingEvents` 退役 + 槽模型底层重构 |

> 判断口诀：**谁有 ADR-0028 以上，谁就是权威侧。** 「远端查不到这些 ADR」只说明没推送，不说明代码不存在、也不说明它无效。

## 2. 开工第一件事：给旧机做快照（不可跳过）

在做任何 `checkout` / `pull` / `reset` / `clean` / 覆盖之前：

1. 把**整个工作目录**（含 `.git/`、`.workbuddy/`、`data/`、所有未跟踪文件）复制到仓库外的安全位置，例如 `D:\_recovery_backup\ai-life-simulator\`，并确认副本能打开、文件数对得上。
2. 把下列状态导出成外部文本留存：
   ```bash
   git status --short
   git log --oneline -30
   git stash list
   git reflog -30
   git branch -a
   ```
3. 导出未提交改动与未跟踪文件：
   ```bash
   git diff > D:/_recovery_backup/wip-tracked.patch
   git diff --cached >> D:/_recovery_backup/wip-tracked.patch
   # 未跟踪文件按 git status 列表单独打包，不要漏 .workbuddy/memory/ 与 specs/iterations/
   ```
4. 单独备份 `docs/DECISIONS.md`（ADR-0028..~0032 正文）、`specs/iterations/` 下的新迭代四件套、`tasks/reports/` 下的验收报告、`specs/data/templates/**/*.yaml`。
5. 若旧机是 git 仓库，在当前 HEAD 打一个本地分支或标签：`git branch recovery/old-machine-snapshot`。

⚠️ 快照没做完，**不要动工作目录里任何一个文件**。

## 3. 绝对禁止（每一条都会抹掉那几轮迭代）

| 禁止 | 为什么 |
|---|---|
| 删掉旧目录、重新 `git clone` | 远端只有 R2.7，clone 回来就是降级 |
| `git reset --hard` / `git checkout -- .` / `git clean -fd` / `git stash drop` | 未提交的在飞工作直接消失 |
| 用新分支/`main` 的文件整目录覆盖（`xcopy /MIR`、`robocopy /MIR`、`cp -r`、`rsync --delete`） | 旧迭代被静默替换，且很难发现 |
| `git push --force`，或在旧机上直接 `git pull` 快进到 `main` | 旧提交被冲掉 / 工作树被覆盖 |
| 为「让新代码能编译」把旧机的 `packages/shared/src/schema/**`、投影契约、`specs/data/templates/**` 换回 R2.7 版本 | 等于主动撤销那两个大版本 |
| 拿「仓库里查不到 ADR-0028..0032」当作旧代码不存在 / 可以丢弃的依据 | 事实是没推送，不是没做 |
| 对线上「咒术转盘人生」执行重新发布 / `workbuddy_sites_deploy` / 下线 | 发布是**覆盖式更新**，会把发布沙箱里可能存着的缺失版本源码包换成当前 R2.7 代码，可能永久抹掉那两个大版本（详见 `RECOVERY_MERGE.md §6`） |
| 为了「把新三国模板送上线」而尝试重新发布 / 单目录增量同步 | 发布工具**没有**单目录增量能力，只有整目录覆盖；模板还是启动期一次性加载、无 reload，塞文件也不会生效。新模板请走本地 `TEMPLATES_DIR` 外挂 + patch 搬运（详见 `RECOVERY_MERGE.md §6.4`） |

## 4. 必须守住的那几次迭代（逐条点名）

| # | 资产 | 守住的判据 |
|---|---|---|
| 1 | **ADR-0026 彻底落地槽模型、`pendingEvents` 退役、底层重构** | 旧机代码里不应再有以 `pendingEvents` 为权威队列的路径；新副本的 ADR-0026 仍是「槽模型转正：pendingEvents 串行化守卫」，**是旧口径，不许拿它覆盖旧机** |
| 2 | **转盘后端返回结果后，前端确认才生效** | 确认 API / 结算时序 / 投影语义仍在；不许退回「后端返回即生效」 |
| 3 | **LLM 与前端逻辑修复（崩溃前正在做）** | 这批可能根本没提交，最容易丢；优先找未跟踪文件、编辑器本地历史、`git reflog`、`.workbuddy/memory/` |
| 4 | **否决「前端不填写密钥 / 不接 LLM」的架构限制裁决** | 疑似对应 `OPEN_QUESTIONS #49`；裁决原文与依据要保住，别被新副本的「#49 未决」口径覆盖 |
| 5 | `ADR-0028..~0032` 正文、`schemaVersion` / 存档结构 | ADR 编号连续、无跳号；契约面以旧机为准 |
| 6 | `specs/data/templates/**/*.yaml`（模板指纹）、`specs/iterations/<新迭代>/`、`tasks/reports/` 新报告 | 指纹与旧机一致；新迭代四件套与验收报告不丢 |
| 7 | `.workbuddy/memory/`（gitignore 的本机日志）、`data/worlds/` 存档、实验脚本 | 这些**不在 git 里**，只能靠第 2 步的目录快照保住 |

## 5. 正确的搬运姿势

### 5.1 在新副本侧导出增量（不推代码也能搬）

```bash
git fetch origin
git log --oneline 8e4b4f7..recovery/merge-2026-11-13
git format-patch -o D:/_recovery_patches 8e4b4f7..recovery/merge-2026-11-13
```

- 生成的 `.patch` 目录（以及本文、`docs/RECOVERY_MERGE.md`）用 U 盘 / 网盘 / 云端项目拷到旧机即可，**不依赖旧机能连 GitHub**。
- 若新分支已被 push，旧机也可 `git fetch origin recovery/merge-2026-11-13` 后直接 `cherry-pick` 对应 sha。
- 若新提交已合进 `main`，起点改用 `git merge-base HEAD <新侧>` 计算，别硬套 `8e4b4f7`。

### 5.2 在旧机上隔离应用

```bash
git checkout -b merge/from-new-branch     # 若旧机不是 git 仓库：先以第 2 步快照建一次基线提交
git am --3way D:/_recovery_patches/*.patch    # 或逐个 git cherry-pick <sha>
```

**一次只应用一个提交**，冲突当场解决、当场验证，不要一把梭。

### 5.3 冲突处理原则

- **旧机契约面为权威**：schema / effect / 投影 / 存档 / 槽模型 / `pendingEvents` 一律以旧机为准；新副本后来写的实现要**适配**旧契约，不许反向回滚旧机。
- **文档类冲突**（`PROJECT.md`、`docs/PROJECT_MEMORY.md`、`tasks/CLOUD_TASKS.md`、`docs/BACKLOG.md`、`specs/iterations/README.md`）：两边事实合并 —— 保留旧机的迭代状态行，再补新副本的核查结论；不要把旧机状态改成「只到 R2.7」。
- **ADR 编号**：`0028..0032` 已被旧机占用；新副本若也写了新 ADR，由旧机侧重编号，不得重号 / 跳号 / 悬空引用。
- **yaml 模板**：以旧机为准；若新提交确实改过 yaml，必须重新计算模板指纹，并在交付说明声明「旧存档全部拒载」（ADR-0007 既定策略）。**新分支新增的 `specs/data/templates/sanguo-2010/` 是独立新目录**（三国梗模板讨董一章小样，见 `tasks/reports/SANGUO-CHAPTER1-SAMPLE.md`）：可整目录叠加，不动 `jjk-2006` 指纹；但线上 `/api/templates` 已是版本化结构（`RECOVERY_MERGE.md §6.2`），旧机模板注册机制可能已变 ⇒ **放入前先核对文件集与 `meta`，别直接当最终形态**。
- **拿不准就停**：写进 `docs/OPEN_QUESTIONS.md` 或 `docs/BACKLOG.md`，不自行拍板、不伪造共识（`AGENTS.md §0.1 / §0.2`）。
- **门禁**：契约面变更须 ADR + G1/G2；`ADR-0027` 的「免前置 ADR + 事后补记」是一次性裁决，**不延续**。

### 5.4 每应用一个提交就验证

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm --filter @life-sim/server start                 # 加载期 fail-fast
pnpm --filter @life-sim/shared test
pnpm --filter @life-sim/game-core exec vitest run --no-file-parallelism \
  src/v2.test.ts src/v2/opening.test.ts src/v2/playthrough.test.ts
pnpm test
node apps/server/smoke/cloud.smoke.mjs             # 需先起 server
```

外加人工自检 §4 七项逐条仍在（尤其 `pendingEvents` 语义、确认 API、LLM 修复）。证据写进 `tasks/reports/`，未跑项不得写 PASS。

## 6. 怀疑迭代丢了，怎么查

1. `grep` 旧机 `docs/DECISIONS.md` 的最大 ADR 编号；查 `pendingEvents` 是否仍被当作权威队列。
2. 找确认 API / 结算时序代码；比对 `specs/data/templates/**/*.yaml` 的指纹是否变化。
3. `git reflog`、`git fsck --unreachable`、编辑器本地历史（VS Code / JetBrains Local History），以及 **WorkBuddy 本机编辑前备份**：`~/.workbuddy/file-history/<会话id>/`、`~/.workbuddy/workspace/sessions/<会话id>/modify_backup/`。文件被覆盖也可能留着旧版本，优先于重建。
4. 对照第 2 步快照逐目录比对文件数与内容。
5. 真丢了就**从快照恢复**，不要试图从远端 clone 重建 —— 远端没有那些版本。

## 7. 给旧机上新开会话的 Agent 的开场白（可直接复制）

> 这是 `ai-life-simulator` 项目。本机（旧机）在电脑崩溃前完成了约两个大版本，ADR 编号推进到 ~0032，内容包括：ADR-0026 彻底落地槽模型并让 `pendingEvents` 退役、转盘后端结果需前端确认才生效、LLM 与前端若干逻辑修复，以及「前端不填密钥 / 不接 LLM」因架构限制被否决。这些成果**没有推送到 GitHub**，远端 `main` 只到 `8e4b4f7`（R2.7 / ADR-0027）。
> 另一台机器的新分支 `recovery/merge-2026-11-13` 之后会继续写实现代码，需要合并到本机。请先读 `docs/RECOVERY_OLD_MACHINE.md`（本守则）与 `docs/RECOVERY_MERGE.md`。
> 硬性要求：① 先把整个工作目录（含 `.git/`、`.workbuddy/`、`data/`、未跟踪文件）做仓库外快照；② 禁止 `reset --hard` / `checkout -- .` / `clean -fd` / 整目录覆盖 / 重新 clone / force push；③ 只能把新分支提交以 `format-patch` + `git am --3way` 或 `cherry-pick` 逐个叠上来；④ 冲突时以本机的契约面（schema / 投影 / 存档 / 槽模型 / yaml）为权威，新实现去适配，不许反向回滚；⑤ 每应用一个提交跑 `RECOVERY_OLD_MACHINE.md §5.4` 的验证集；⑥ 不确定的产品规则写 `docs/OPEN_QUESTIONS.md`，不得伪造共识或把未跑项写成 PASS；⑦ 找回前**禁止对线上「咒术转盘人生」重新发布或下线**，发布是覆盖式更新，会把发布沙箱里可能存着的缺失版本源码包换成当前 R2.7 代码。

## 8. 让这份文档到达旧机

- **推荐**：把分支推到远端（需主理人执行或授权），`main` 不受影响：
  ```bash
  git push -u origin recovery/merge-2026-11-13
  ```
  旧机 `git fetch origin` 后即可在 `origin/recovery/merge-2026-11-13` 上读到本文与 `RECOVERY_MERGE.md`。
- **离线**：单独拷贝 `docs/RECOVERY_OLD_MACHINE.md`、`docs/RECOVERY_MERGE.md` 与 §5.1 的 patch 目录，U 盘 / 网盘 / WorkBuddy 云端项目均可。
- ⚠️ 旧机直接 `git pull` 只会拿到 `main`，**不会自动带来这两份文档**；必须显式 fetch 指定分支，或直接拷贝文件。

## 9. 本文件留痕

- 所属分支：`recovery/merge-2026-11-13`（基于 `main @ 8e4b4f7`）。
- 本轮只新增文档，未改任何 `packages/**` / `apps/**` / `specs/**` 源码或 yaml ⇒ **模板指纹不变、旧存档不受影响、无玩法结构变更**；**未修改 Spec**。
- 文中关于旧机那两个大版本的描述来自主理人口述，**未经代码核验**，只作「守住什么」的清单，不作已实现 / 已验证的证据。
