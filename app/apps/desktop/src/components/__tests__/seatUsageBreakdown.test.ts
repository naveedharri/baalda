// SPDX-License-Identifier: Apache-2.0

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SEAT_EXPLAINER, SeatUsageBreakdown } from "../SeatUsageBreakdown";

const fmt = (iso: string) => `D(${iso})`;
const cells = (html: string) => [...html.matchAll(/<td>(\d+)<\/td>/g)].map((m) => Number(m[1]));

function render(overrides: Partial<Parameters<typeof SeatUsageBreakdown>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(SeatUsageBreakdown, {
      seats: { purchased: 10, used: 4, reserved: 2, pendingDecrease: null },
      canManage: true,
      formatDate: fmt,
      onManage: vi.fn(),
      onKeepSeats: vi.fn(async () => undefined),
      ...overrides,
    }),
  );
}

describe("SeatUsageBreakdown", () => {
  it("shows Seats, Claimed, Reserved and Available with the explainer", () => {
    const html = render();
    for (const h of ["Seats", "Claimed", "Reserved", "Available"]) expect(html).toContain(`<th>${h}</th>`);
    expect(cells(html)).toEqual([10, 4, 2, 4]);
    expect(html).toContain(SEAT_EXPLAINER.replace("'", "&#x27;"));
    expect(html).toContain("Add or change seats");
    expect(html).not.toContain("Planned seat change");
  });

  it("never shows negative availability", () => {
    expect(cells(render({ seats: { purchased: 3, used: 3, reserved: 2, pendingDecrease: null } }))).toEqual([3, 3, 2, 0]);
  });

  it("shows a planned decrease above the table with Keep for the owner", () => {
    const html = render({
      seats: { purchased: 8, used: 3, reserved: 0, pendingDecrease: { to: 5, effectiveAt: "2026-11-01" } },
    });
    expect(html).toContain("Planned seat change: 5 seats from D(2026-11-01). Changes to seats take effect next billing cycle.");
    expect(html).toContain("Keep 8 seats");
    expect(html.indexOf("Planned seat change")).toBeLessThan(html.indexOf("<table"));
  });

  it("is read-only for non-owners", () => {
    const html = render({
      canManage: false,
      seats: { purchased: 8, used: 3, reserved: 0, pendingDecrease: { to: 5, effectiveAt: "2026-11-01" } },
    });
    expect(html).toContain("Planned seat change");
    expect(html).not.toContain("Keep 8 seats");
    expect(html).not.toContain("Add or change seats");
  });
});
