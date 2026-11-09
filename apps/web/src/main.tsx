import React from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

function App() {
  return (
    <main className="shell">
      <header>
        <p className="eyebrow">AI LIFE SIMULATOR · DEMO</p>
        <h1>人生模拟器</h1>
        <p className="muted">世界仍在继续。你的故事即将开始。</p>
      </header>
      <section className="card">
        <span className="tag">工程起始页</span>
        <h2>先建立你的世界</h2>
        <p>当前是工程脚手架。下一步由 Coding Agent 按照 specs 实现 P0 模拟闭环。</p>
      </section>
      <nav className="tabs">
        <span className="active">人生</span><span>人物</span><span>世界</span><span>记录</span>
      </nav>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
