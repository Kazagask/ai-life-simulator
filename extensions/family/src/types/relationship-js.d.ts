/**
 * `relationship.js` 无官方类型声明（ADR-0014 裁决引入）。
 * 只声明本项目实际使用的调用面，避免 any 泄漏进内核。
 */
declare module "relationship.js" {
  interface RelationshipOptions {
    /** 关系链记号，如「爸爸的妈妈」「哥哥的儿子」 */
    text: string;
    /** 目标称谓视角（'自己' / '爸爸' …），本内核不使用 */
    target?: string;
    /** 1 = 男，0 = 女 */
    sex?: 0 | 1;
    /** 'default' | 'chain' | 'pair' | 'distance' */
    type?: string;
    reverse?: boolean;
  }

  /** 命中返回称谓数组（可能多解，如「舅表姐」「舅表妹」）；无命中返回空数组。纯函数。 */
  function relationship(options: RelationshipOptions): string[];

  export default relationship;
}
