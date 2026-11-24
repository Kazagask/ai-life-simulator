import type { StatusVM } from "@life-sim/shared";
import { StyledName, styleBoxClassName, styleBoxInline } from "./StyledName.js";

export interface StatusChipProps {
  status: StatusVM;
  /** 缺省 ⇒ 只读芯片（`span`）；给了 ⇒ 可点开详情（`button`）。 */
  onSelect?: (status: StatusVM) => void;
  /**
   * 是否在芯片上显示剩余回合。默认 `true`（战斗面板要这口战术信息）。
   *
   * 人生页顶部的角色卡关掉：那里是「我身上有什么」，不是战斗面板；
   * 「还剩 3 回合」在非战斗上下文里读起来像倒计时，玩家 2026-11-23 明确要求移除。
   */
  showDuration?: boolean;
}

/**
 * 状态芯片：**全工程唯一**的状态呈现入口（个人面板、NPC 卡、状态浮窗、召唤物面板）。
 *
 * 以前每个面板各写一份，于是同一个状态在三处长得不一样：NPC 卡上没有
 * `status-chip--{kind}` 的虚线框，层数 `×2` 落在样式 span 外面，于是别人身上
 * 的修正看起来是天赋、叠层也不跟名字同色（用户 2026-11-20 报的就是这个）。
 *
 * 三条规矩写在这里，别在调用处重复：
 * 1. **实线 = 天赋，虚线 = 修正 / 战斗状态**（`.status-chip--{kind}`）：只靠分组标题
 *    区分不够，滚动之后标题就不在屏里了；
 * 2. **层数跟名字同一段文本**（放在 `StyledName` 的 children 里）：`×2` 必须继承
 *    名字的颜色 / 加粗 / 下划线，否则玩家会以为那是另一个字段；
 * 3. **`modifier` 不写剩余天数**（详情里才有），`battle` 写回合数 ——
 *    回合数是这一场里的战术信息，藏起来就算不出还能不能撑住。
 */
export function StatusChip({ status, onSelect, showDuration = true }: StatusChipProps) {
  const box = styleBoxClassName(status.style);
  const withDuration = showDuration && status.kind === "battle";
  const label = (
    <>
      <StyledName style={status.style}>
        {status.name}
        {status.stacks > 1 ? `×${status.stacks}` : ""}
      </StyledName>
      {withDuration && status.durationLabel !== undefined ? (
        <span className="status-chip__meta">{status.durationLabel}</span>
      ) : null}
      {/* 成长型天赋：按**阶梯**给（1/4 → 4/8），到顶写「已完成」，不铺整张表 */}
      {status.progress !== undefined ? (
        <span className="status-chip__meta status-chip__progress">
          {status.progress.done
            ? `${status.progress.target}/${status.progress.target} 已完成`
            : `${status.progress.current}/${status.progress.target}`}
        </span>
      ) : null}
    </>
  );
  const className = `chip status-chip status-chip--${status.kind}${box === "" ? "" : ` ${box}`}`;

  if (onSelect === undefined) {
    return (
      <span className={className} style={styleBoxInline(status.style)}>
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={`${className} status-chip--action`}
      style={styleBoxInline(status.style)}
      onClick={() => onSelect(status)}
    >
      {label}
    </button>
  );
}
