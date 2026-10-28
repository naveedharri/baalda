// A failed install waits 10 minutes between tries and gives up after 3 retries.
import { describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", () => ({}));
vi.mock("../../serverFeatures", () => ({ serverFeatures: async () => new Set(["skills"]) }));
vi.mock("../../toast", () => ({ toast: vi.fn() }));

import { installRetryDue, SKILLS_INSTALL_MAX_FAILURES, SKILLS_INSTALL_RETRY_MS } from "../syncHost";

describe("installRetryDue", () => {
  const at = 1_000_000;
  it("waits the retry gap after a failure", () => {
    expect(installRetryDue({ failures: 1, lastAt: at }, at + SKILLS_INSTALL_RETRY_MS - 1)).toBe(false);
    expect(installRetryDue({ failures: 1, lastAt: at }, at + SKILLS_INSTALL_RETRY_MS)).toBe(true);
  });
  it("allows three retries after the first failure, then stops", () => {
    expect(SKILLS_INSTALL_MAX_FAILURES).toBe(4);
    expect(installRetryDue({ failures: 3, lastAt: at }, at + SKILLS_INSTALL_RETRY_MS)).toBe(true);
    expect(installRetryDue({ failures: 4, lastAt: at }, at + 10 * SKILLS_INSTALL_RETRY_MS)).toBe(false);
  });
});
