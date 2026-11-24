/**
 * PWA 注册与更新提示（只在生产构建生效）。
 *
 * 更新判据是 `/sw.js` 的字节变化：每次构建都会写入新的 `CACHE_VERSION` 与预缓存清单。
 * 新 SW 装好后**不立刻接管**（避免玩家正在打的回合被换掉），由页面提示「有新版本」，
 * 玩家点刷新后再 `skipWaiting` + `controllerchange` 重载。
 */
let registration: ServiceWorkerRegistration | null = null;
let notified = false;

export function registerPwa(onUpdateReady: () => void): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;

  const start = (): void => {
    void navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => {
        registration = reg;

        const watch = (): void => {
          const installing = reg.installing;
          if (installing === null) return;
          installing.addEventListener("statechange", () => {
            // 首次安装没有 controller，属于正常激活，不提示。
            if (installing.state === "installed" && navigator.serviceWorker.controller !== null && !notified) {
              notified = true;
              onUpdateReady();
            }
          });
        };

        reg.addEventListener("updatefound", watch);
        watch();
        void reg.update().catch(() => undefined);
      })
      .catch(() => {
        // 注册失败（隐私模式 / 非安全上下文）不影响游戏。
      });
  };

  if (document.readyState === "complete") start();
  else window.addEventListener("load", start, { once: true });

  // 从后台切回前台时查一次；不轮询，省电。
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void registration?.update().catch(() => undefined);
  });
}

export function applyPwaUpdate(): void {
  const waiting = registration?.waiting;
  if (waiting === undefined || waiting === null) {
    window.location.reload();
    return;
  }
  navigator.serviceWorker.addEventListener("controllerchange", () => window.location.reload(), { once: true });
  waiting.postMessage({ type: "SKIP_WAITING" });
}
