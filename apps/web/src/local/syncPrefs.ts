/**
 * 云端同步偏好（本机）。
 *
 * **默认关闭**：没有显式开启时，存档与 trace 一个请求都不发（用户 2026-11-22 裁决）。
 * 手动上传不受它影响 —— 那是玩家当次的显式动作，不是后台行为。
 *
 * 存本机而不是云端：这是"这台设备要不要自动传"的偏好；新设备默认关闭更安全，
 * 也不会出现"为了读设置先同步"的鸡生蛋。
 */
const KEY = "life-sim:cloud-auto-sync";

/** 偏好变化事件：同页多个组件（档案页 / 设置）要一起变。 */
export const SYNC_PREF_EVENT = "life-sim:sync-pref";

export function isAutoSyncEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) === "on";
  } catch {
    return false;
  }
}

export function setAutoSyncEnabled(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    // 隐私模式 / 测试环境：不持久化，当次调用方自己持有状态。
  }
  try {
    window.dispatchEvent(new Event(SYNC_PREF_EVENT));
  } catch {
    // 无 window 的环境（单测）忽略。
  }
}
