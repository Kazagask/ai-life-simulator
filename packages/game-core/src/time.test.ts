import { describe, expect, it } from "vitest";
import { determineStep, toMinutes } from "./time.js";
import type { Character, WorldTemplate } from "@life-sim/shared";

const character: Character = {
  id: "player",
  name: "Test",
  age: 17,
  lifeStage: "youth",
  attributes: {},
  goals: [],
  knowledge: [],
  secrets: [],
};

const template: WorldTemplate = {
  id: "test",
  defaultStep: { value: 1, unit: "day" },
  lifeStageSteps: {
    youth: { value: 1, unit: "week" },
    adulthood: { value: 1, unit: "month" },
  },
  events: [],
};

describe("time pacing", () => {
  it("uses life-stage pacing by default", () => {
    expect(toMinutes(determineStep(character, template))).toBe(10080);
  });

  it("allows an action to override the default step", () => {
    expect(toMinutes(determineStep(character, template, { value: 2, unit: "hour" }))).toBe(120);
  });
});
