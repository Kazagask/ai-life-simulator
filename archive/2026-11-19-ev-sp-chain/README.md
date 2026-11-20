# 旧「星浆体」链（ev-sp-00 … ev-sp-06）归档

2026-11-19 从 `specs/data/templates/jjk-2006/3.0.0/events.yaml` 移除。

## 为什么移除

旧链是一条**单线程悲剧**：从 `ev-ch1-gate` 分「跟去 / 留守」两路，最后都汇到
`ev-sp-06` 的同一个「那年夏天结束了」。它只有两个问题：

1. 只有两个真出口（理子死 / 理子被带走），而设计稿 L1 要求四个
   （`shot` / `saved` / `merged` / `playerDead`）；
2. 推进几乎全靠选项，没有 `settle.random`，不符合「选项定方向、转盘定结果」
   （design.md §3.5 / §8.5）。

## 被谁取代

`ev-hv-01 … ev-hv-07`：2006 夏「怀玉」七幕，逐日推进；每幕一个加权转盘，
选项每组至多一组；出口按 `rikoOutcome` 落 `shot` / `saved` / `merged` / `playerDead`。

## 本目录内容

- `events-sp.yaml`：旧链原文，未改动。仅作对照，不被任何模板加载。
- 旧链的旗标（`rikoDead` / `rikoEscaped` / `rikoSacrificed` / `tenjinEvolved` 等）
  也随链一起退役；新链的因果旗标见 `3.0.0/events.yaml` 的 `assimilationFailed` /
  `starVesselGone` / `tengenCursed`。
