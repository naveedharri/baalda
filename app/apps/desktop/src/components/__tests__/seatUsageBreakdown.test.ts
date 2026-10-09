// SPDX-License-Identifier: Apache-2.0

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SeatUsageBreakdown } from "../SeatUsageBreakdown";

const cells = (html: string) => [...html.matchAll(/<td>(\d+)<\/td>/g)].map((m) => Number(m[1]));

function render(overrides: Partial<Parameters<typeof SeatUsageBreakdown>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(SeatUsageBreakdown, {
      seats: { purchased: 10, used: 4, reserved: 2, pendingDecrease: null },
      canManage: true,
      onManage: vi.fn(),
      ...overrides,
    }),
  );
}

describe("SeatUsageBreakdown", () => {
  it("shows Seats, Claimed, Invited and Available without a caption", () => {
    const html = render();
    for (const h of ["Seats", "Claimed", "Invited", "Available"]) expect(html).toContain(`<th>${h}</th>`);
    expect(cells(html)).toEqual([10, 4, 2, 4]);
    expect(html).not.toContain("Seats are what you pay for");
    expect(html).toContain("Add or change seats");
    expect(html).not.toContain("Planned seat change");
  });

  it("never shows negative availability", () => {
    expect(cells(render({ seats: { purchased: 3, used: 3, reserved: 2, pendingDecrease: null } }))).toEqual([3, 3, 2, 0]);
  });

  it("never shows a planned decrease on the card (it lives in Manage seats)", () => {
    const html = render({
      seats: { purchased: 8, used: 3, reserved: 0, pendingDecrease: { to: 5, effectiveAt: "2026-11-01" } },
    });
    expect(html).not.toContain("Planned seat change");
    expect(html).not.toContain("Keep 8 seats");
    expect(cells(html)).toEqual([8, 3, 0, 5]);
  });

  it("is read-only for non-owners", () => {
    const html = render({ canManage: false });
    expect(html).not.toContain("Add or change seats");
  });

  it("shows no vault chips when the list is empty or missing", () => {
    expect(render()).not.toContain("plan-page-vault-chip");
    expect(render({ invitedByVault: [] })).not.toContain("plan-page-vault-chip");
  });

  it("lists one chip per vault under the Invited number", () => {
    const html = render({
      invitedByVault: [
        { orgId: "a", name: "Design", count: 1 },
        { orgId: "b", name: "Sales", count: 1 },
      ],
    });
    expect(html.match(/class="plan-page-vault-chip"/g)).toHaveLength(2);
    expect(html).toContain("Design · 1");
    expect(html).toContain("Sales · 1");
    expect(cells(html)).toEqual([10, 4, 4]);
  });
});
