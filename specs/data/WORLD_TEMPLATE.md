# 世界模板数据契约草案

模板采用 JSON/TypeScript 数据定义；引擎不允许硬编码具体世界观。

```text
templates/<template-id>/
  manifest.json
  world.config.json
  time.config.json
  rules.config.json
  characters/
  locations/
  events/
  narrative/
```

## 必备配置概念

- `manifest`: id、名称、版本、兼容引擎版本
- `world`: 世界简介、初始时间、难度、初始地点
- `time`: calendar adapter、life stages、pacing policies、time units
- `rules`: 属性、行动、资源、能力规则
- `characters`: NPC 初始状态、人格、目标、关系、知识、秘密
- `events`: 触发条件、权重、概率、冷却、效果、事件链
- `narrative`: 叙事风格、视角、长度、禁区

## 模板原则

- 通用引擎只读取模板契约，不 import 某个模板的专属代码。
- 模板必须声明 schema version。
- 模板加载时进行 Zod 校验。
- 模板缺字段或版本不兼容时给出可诊断错误。
