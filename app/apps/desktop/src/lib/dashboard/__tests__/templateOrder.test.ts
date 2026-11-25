import { describe, expect, it } from "vitest";
import { DASHBOARD_TEMPLATES, isDarkTemplate, mixedTemplateOrder, templateCategories } from "../templates";

describe("dashboard gallery order", () => {
  it("puts Minimal first after All styles", () => {
    expect(templateCategories(DASHBOARD_TEMPLATES)[0]).toBe("Minimal");
  });

  it("All styles keeps every design once, leads with a light Minimal one, and never stacks dark ones", () => {
    const order = mixedTemplateOrder(DASHBOARD_TEMPLATES);
    expect(new Set(order.map((t) => t.id))).toEqual(new Set(DASHBOARD_TEMPLATES.map((t) => t.id)));
    expect(order).toHaveLength(DASHBOARD_TEMPLATES.length);
    expect(isDarkTemplate(order[0])).toBe(false);
    expect(order[0].category).toBe("Minimal");
    for (let i = 1; i < order.length; i++) {
      expect(isDarkTemplate(order[i]) && isDarkTemplate(order[i - 1])).toBe(false);
    }
    // Every row of three on a wide window shows at most one dark design and
    // the first rows each show one, so dark and light read as a mix.
    const rows = [0, 1, 2, 3].map((r) => order.slice(r * 3, r * 3 + 3).filter(isDarkTemplate).length);
    expect(rows.every((n) => n <= 1)).toBe(true);
    expect(order.slice(0, 9).some(isDarkTemplate)).toBe(true);
  });
});
