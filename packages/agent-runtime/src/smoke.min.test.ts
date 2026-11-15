import { expect, it } from "vitest";
import { AGENT_RUNTIME_VERSION } from "./index.js";

it("agent-runtime package is resolvable", () => {
  expect(AGENT_RUNTIME_VERSION).toBe("0.2.0");
});
