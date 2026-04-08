import { describe, it, expect, beforeEach, vi } from "vitest";
import { useColorRuleStore, ColorRule, LIGHT_COLORS } from "../useColorRuleStore";

// Mock crypto.randomUUID for deterministic test IDs
let uuidCounter = 0;
vi.stubGlobal("crypto", {
  randomUUID: () => `test-uuid-${++uuidCounter}`,
});

beforeEach(() => {
  uuidCounter = 0;
  useColorRuleStore.getState().clearRules();
});

// ---------------------------------------------------------------------------
// Initial State
// ---------------------------------------------------------------------------

describe("initial state (after clearRules)", () => {
  it("has empty color rules", () => {
    expect(useColorRuleStore.getState().colorRules).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// addRule
// ---------------------------------------------------------------------------

describe("addRule", () => {
  it("adds a rule with generated ID", () => {
    useColorRuleStore.getState().addRule({
      field: "level",
      operator: "eq",
      value: "ERROR",
      color: "bg-red-50",
      enabled: true,
    });
    const rules = useColorRuleStore.getState().colorRules;
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe("test-uuid-1");
    expect(rules[0].field).toBe("level");
    expect(rules[0].operator).toBe("eq");
    expect(rules[0].value).toBe("ERROR");
    expect(rules[0].color).toBe("bg-red-50");
    expect(rules[0].enabled).toBe(true);
  });

  it("appends rules in order", () => {
    useColorRuleStore.getState().addRule({
      field: "level",
      operator: "eq",
      value: "ERROR",
      color: "bg-red-50",
      enabled: true,
    });
    useColorRuleStore.getState().addRule({
      field: "level",
      operator: "eq",
      value: "WARN",
      color: "bg-yellow-50",
      enabled: true,
    });
    const rules = useColorRuleStore.getState().colorRules;
    expect(rules).toHaveLength(2);
    expect(rules[0].value).toBe("ERROR");
    expect(rules[1].value).toBe("WARN");
  });

  it("supports all operator types", () => {
    const operators: ColorRule["operator"][] = [
      "eq",
      "neq",
      "contains",
      "exists",
      "regex",
    ];
    for (const op of operators) {
      useColorRuleStore.getState().addRule({
        field: "test",
        operator: op,
        value: "val",
        color: "bg-blue-50",
        enabled: true,
      });
    }
    expect(useColorRuleStore.getState().colorRules).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// updateRule
// ---------------------------------------------------------------------------

describe("updateRule", () => {
  it("updates specific fields of a rule", () => {
    useColorRuleStore.getState().addRule({
      field: "level",
      operator: "eq",
      value: "ERROR",
      color: "bg-red-50",
      enabled: true,
    });
    const id = useColorRuleStore.getState().colorRules[0].id;

    useColorRuleStore
      .getState()
      .updateRule(id, { color: "bg-blue-50", value: "CRITICAL" });

    const updated = useColorRuleStore.getState().colorRules[0];
    expect(updated.color).toBe("bg-blue-50");
    expect(updated.value).toBe("CRITICAL");
    expect(updated.field).toBe("level"); // unchanged
    expect(updated.operator).toBe("eq"); // unchanged
  });

  it("does not affect other rules", () => {
    useColorRuleStore.getState().addRule({
      field: "level",
      operator: "eq",
      value: "A",
      color: "bg-red-50",
      enabled: true,
    });
    useColorRuleStore.getState().addRule({
      field: "level",
      operator: "eq",
      value: "B",
      color: "bg-blue-50",
      enabled: true,
    });
    const id = useColorRuleStore.getState().colorRules[0].id;
    useColorRuleStore.getState().updateRule(id, { value: "A-updated" });

    expect(useColorRuleStore.getState().colorRules[1].value).toBe("B");
  });
});

// ---------------------------------------------------------------------------
// deleteRule
// ---------------------------------------------------------------------------

describe("deleteRule", () => {
  it("removes the rule by ID", () => {
    useColorRuleStore.getState().addRule({
      field: "level",
      operator: "eq",
      value: "ERROR",
      color: "bg-red-50",
      enabled: true,
    });
    const id = useColorRuleStore.getState().colorRules[0].id;
    useColorRuleStore.getState().deleteRule(id);
    expect(useColorRuleStore.getState().colorRules).toHaveLength(0);
  });

  it("only removes the targeted rule", () => {
    useColorRuleStore.getState().addRule({
      field: "a",
      operator: "eq",
      value: "1",
      color: "bg-red-50",
      enabled: true,
    });
    useColorRuleStore.getState().addRule({
      field: "b",
      operator: "eq",
      value: "2",
      color: "bg-blue-50",
      enabled: true,
    });
    const id = useColorRuleStore.getState().colorRules[0].id;
    useColorRuleStore.getState().deleteRule(id);
    expect(useColorRuleStore.getState().colorRules).toHaveLength(1);
    expect(useColorRuleStore.getState().colorRules[0].field).toBe("b");
  });
});

// ---------------------------------------------------------------------------
// toggleRule
// ---------------------------------------------------------------------------

describe("toggleRule", () => {
  it("toggles enabled to disabled", () => {
    useColorRuleStore.getState().addRule({
      field: "level",
      operator: "eq",
      value: "ERROR",
      color: "bg-red-50",
      enabled: true,
    });
    const id = useColorRuleStore.getState().colorRules[0].id;
    useColorRuleStore.getState().toggleRule(id);
    expect(useColorRuleStore.getState().colorRules[0].enabled).toBe(false);
  });

  it("toggles disabled to enabled", () => {
    useColorRuleStore.getState().addRule({
      field: "level",
      operator: "eq",
      value: "ERROR",
      color: "bg-red-50",
      enabled: false,
    });
    const id = useColorRuleStore.getState().colorRules[0].id;
    useColorRuleStore.getState().toggleRule(id);
    expect(useColorRuleStore.getState().colorRules[0].enabled).toBe(true);
  });

  it("double toggle returns to original state", () => {
    useColorRuleStore.getState().addRule({
      field: "level",
      operator: "eq",
      value: "ERROR",
      color: "bg-red-50",
      enabled: true,
    });
    const id = useColorRuleStore.getState().colorRules[0].id;
    useColorRuleStore.getState().toggleRule(id);
    useColorRuleStore.getState().toggleRule(id);
    expect(useColorRuleStore.getState().colorRules[0].enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// moveRule
// ---------------------------------------------------------------------------

describe("moveRule", () => {
  it("moves rule from first to last position", () => {
    useColorRuleStore.getState().addRule({
      field: "a",
      operator: "eq",
      value: "1",
      color: "bg-red-50",
      enabled: true,
    });
    useColorRuleStore.getState().addRule({
      field: "b",
      operator: "eq",
      value: "2",
      color: "bg-blue-50",
      enabled: true,
    });
    useColorRuleStore.getState().addRule({
      field: "c",
      operator: "eq",
      value: "3",
      color: "bg-green-50",
      enabled: true,
    });

    useColorRuleStore.getState().moveRule(0, 2);

    const rules = useColorRuleStore.getState().colorRules;
    expect(rules[0].field).toBe("b");
    expect(rules[1].field).toBe("c");
    expect(rules[2].field).toBe("a");
  });

  it("moves rule from last to first position", () => {
    useColorRuleStore.getState().addRule({
      field: "a",
      operator: "eq",
      value: "1",
      color: "bg-red-50",
      enabled: true,
    });
    useColorRuleStore.getState().addRule({
      field: "b",
      operator: "eq",
      value: "2",
      color: "bg-blue-50",
      enabled: true,
    });

    useColorRuleStore.getState().moveRule(1, 0);

    const rules = useColorRuleStore.getState().colorRules;
    expect(rules[0].field).toBe("b");
    expect(rules[1].field).toBe("a");
  });
});

// ---------------------------------------------------------------------------
// clearRules
// ---------------------------------------------------------------------------

describe("clearRules", () => {
  it("removes all rules", () => {
    useColorRuleStore.getState().addRule({
      field: "a",
      operator: "eq",
      value: "1",
      color: "bg-red-50",
      enabled: true,
    });
    useColorRuleStore.getState().addRule({
      field: "b",
      operator: "eq",
      value: "2",
      color: "bg-blue-50",
      enabled: true,
    });

    useColorRuleStore.getState().clearRules();
    expect(useColorRuleStore.getState().colorRules).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// LIGHT_COLORS constant
// ---------------------------------------------------------------------------

describe("LIGHT_COLORS", () => {
  it("has 18 color options", () => {
    expect(LIGHT_COLORS).toHaveLength(18);
  });

  it("all have name and value", () => {
    for (const color of LIGHT_COLORS) {
      expect(color.name).toBeTruthy();
      expect(color.value).toBeTruthy();
      expect(color.value).toMatch(/^bg-\w+-50$/);
    }
  });
});
