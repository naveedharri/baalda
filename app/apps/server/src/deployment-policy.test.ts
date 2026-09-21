// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from "vitest";
import { requiresCloudPlan } from "./deployment-policy.js";
afterEach(() => vi.unstubAllEnvs());
it.each(["", "operator-billing-token"])("keeps self-hosted AI independent of billing (%s)", token => {
  vi.stubEnv("BAALDA_DEPLOYMENT", "self-hosted"); vi.stubEnv("POLAR_ACCESS_TOKEN", token);
  expect(requiresCloudPlan()).toBe(false);
});
it.each(["", "cloud-billing-token"])("keeps Cloud AI Pro-only independent of billing availability (%s)", token => {
  vi.stubEnv("BAALDA_DEPLOYMENT", "cloud"); vi.stubEnv("POLAR_ACCESS_TOKEN", token);
  expect(requiresCloudPlan()).toBe(true);
});
it("defaults to restricted Cloud policy and rejects misspelled modes", () => {
  vi.stubEnv("BAALDA_DEPLOYMENT", undefined); expect(requiresCloudPlan()).toBe(true);
  vi.stubEnv("BAALDA_DEPLOYMENT", "selfhost"); expect(() => requiresCloudPlan()).toThrow("BAALDA_DEPLOYMENT");
});
