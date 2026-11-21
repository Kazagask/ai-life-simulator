import { advanceTurnV2, createLookup, createWorldV2 } from "@life-sim/game-core";
import { sha256Hex, stableStringify, type WorldStateV2, type WorldTemplateV2 } from "@life-sim/shared";
import { loadLocalWorld, saveLocalWorld } from "./localWorldStore";

/**
 * 本地引擎自检（ADR-070 第二期 · 客户端化的第一颗钉子）。
 *
 * 它做的事很小：**用下载来的模板在浏览器里起一个世界、推进一轮、写进 IndexedDB、读回来比对**。
 * 但这一小步会把三件以前只在 Node 里发生的事搬到客户端：
 * 1) game-core 被真正调用（打包、tree-shaking、有没有偷偷依赖 `node:`）；
 * 2) 同一份模板 + 同一 seed 在浏览器里能确定性地产出状态（摘要可比）；
 * 3) 世界状态能被结构化克隆进 IndexedDB 并原样取回。
 *
 * 它**不**取代服务端：世界仍以服务端为准，这里建的是 `self-check:` 开头的本地样本。
 * 等这一步稳定，再把「玩家真正在玩的那一局」搬到本地。
 */

export interface LocalEngineCheck {
  ok: boolean;
  /** 推进后的轮次（建世界 + 1 轮）。 */
  turnIndex?: number;
  /** 状态摘要（sha256 前 18 位，足以人眼比对）。 */
  digest?: string;
  /** 写进 IndexedDB 又读回来，摘要一致。 */
  persisted: boolean;
  message?: string;
}

/** 状态摘要：键序稳定 + 纯 TS sha256（浏览器与服务端同一实现）。 */
export function localStateDigest(state: WorldStateV2): string {
  return sha256Hex(stableStringify(state));
}

/** 选一个「一定存在」的行动：优先 rest，否则模板声明的第一个。 */
function actionIdOf(template: WorldTemplateV2): string | undefined {
  const actions = template.actions ?? [];
  return actions.find((action) => action.id === "rest")?.id ?? actions[0]?.id;
}

export async function runLocalEngineSelfCheck(
  template: WorldTemplateV2,
  templateFingerprint: string,
  templateVersion: string,
): Promise<LocalEngineCheck> {
  const id = `self-check:${template.meta.id}`;
  try {
    const state = createWorldV2(
      // seed 固定：同一份模板每次自检必须得到同一份状态（否则「确定性」这词就是假的）。
      { templateId: template.meta.id, playerName: "本地自检", seed: 20261121 },
      template,
      id,
    );
    // 这是「直接起世界」的路径（不经过开局 DAG），与 `POST /api/worlds` 同义。
    state.openingCompleted = true;

    const actionId = actionIdOf(template);
    if (actionId !== undefined) {
      advanceTurnV2(state, { action: { type: actionId, description: "" } }, template, createLookup(template));
    }

    const digest = localStateDigest(state);
    await saveLocalWorld({
      id,
      formatVersion: 1,
      savedAt: new Date().toISOString(),
      templateId: template.meta.id,
      templateVersion,
      templateFingerprint,
      state,
    });
    const loaded = await loadLocalWorld(id);
    const persisted = loaded !== undefined && localStateDigest(loaded.state) === digest;

    return {
      ok: true,
      turnIndex: state.turnIndex,
      digest: digest.slice(0, 18),
      persisted,
    };
  } catch (error) {
    return {
      ok: false,
      persisted: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
