import { expect, it } from "vitest";
import { RPG_UI_VERSION } from "./index.js";

it("rpg-ui package is resolvable", () => {
  expect(RPG_UI_VERSION).toBe("0.1.0");
});
