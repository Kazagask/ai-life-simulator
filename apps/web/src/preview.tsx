/**
 * UI 预览页（**仅开发用**，不进构建产物）。
 *
 * 用途：改 `packages/rpg-ui` 的卡片 / 面板 / 关系图时，不必走一遍开局就能在
 * 430 / 360px 下截图核对。数据来自 `.tmp` 脚本导出的真实投影（`__preview/fixtures.json`），
 * 不是手搓的假 VM —— 形状一旦漂移，这里会先炸。
 *
 * 启动：`pnpm --filter @life-sim/web dev` → 打开 `/preview.html`。
 */
import { createRoot } from "react-dom/client";
import { CharacterPanel, NpcCard, RelationGraph } from "@life-sim/rpg-ui";
import "../../../packages/rpg-ui/src/styles.css";
import "./style.css";
import fixtures from "./__preview/fixtures.json";

const view = (fixtures as { view: Record<string, unknown> }).view as never as {
  player: Parameters<typeof CharacterPanel>[0]["player"];
  npcs: Array<Parameters<typeof NpcCard>[0]["npc"]>;
  equipmentSlots: never;
  relations: Array<{ kind: string; kindLabel: string; typeLabel?: string; counterpartName?: string; direction: string; counterpartId?: string }>;
  media: Array<{ slot: string; assetId: string; url: string; alt: string }>;
};

const avatarOf = (id: string) => view.media?.find((m) => m.slot === `avatar.${id}`);
const avatarFor = (id: string) => {
  const hit = avatarOf(id);
  return hit === undefined ? undefined : { url: hit.url, alt: hit.alt };
};

/** 关系图要的是 `NpcRelationVM[]`（`withId/withName/...`），从 NPC 卡的出边里摊平即可。 */
type Rel = { withId: string; withName: string; kind: string; kindLabel: string; typeLabel?: string; direction: string; counterpartVisible?: boolean };
const graphRelations = (view.npcs as unknown as Array<{ relations: Rel[] }>)
  .flatMap((n) => n.relations)
  .filter((r) => r.direction !== "in")
  .map((r) => ({ ...r, counterpartId: r.withId }));

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 18 }}>
      <h4 style={{ margin: "0 0 8px", color: "var(--ls-gold)", fontSize: 12, letterSpacing: "0.12em" }}>{title}</h4>
      {children}
    </section>
  );
}

createRoot(document.getElementById("preview-root")!).render(
  <div style={{ maxWidth: 430, margin: "0 auto", padding: 12 }}>
    <Block title="NPC 卡 · 有头像">
      <NpcCard
        npc={view.npcs.find((n) => avatarOf(n.id) !== undefined) ?? view.npcs[0]!}
        {...(avatarOf((view.npcs[0] ?? { id: "" }).id) !== undefined ? { avatar: avatarOf(view.npcs[0]!.id) } : {})}
      />
    </Block>
    <Block title="NPC 卡 · 无头像">
      <NpcCard npc={view.npcs[1]!} />
    </Block>
    <Block title="人物面板">
      <CharacterPanel player={view.player} avatar={avatarOf(view.player.id)} slots={(view.equipmentSlots ?? []) as never} />
    </Block>
    <Block title="关系图">
      <RelationGraph selfName={view.player.name} selfId={view.player.id} avatarOf={avatarFor} relations={graphRelations as never} />
    </Block>
  </div>,
);
