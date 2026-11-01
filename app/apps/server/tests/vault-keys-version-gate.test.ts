import { describe, expect, it } from "vitest";
import { isVaultKeyCapableVersion, VAULT_KEYS_MIN_DESKTOP } from "../src/http/client-version.js";

// Staging builds report `<base>-staging.<run>`: the gate must judge the numeric
// base only, or every staging user would be locked out of keyed vaults.
describe("vault-key capable desktop versions", () => {
  it("accepts the minimum, its staging builds and anything newer", () => {
    expect(VAULT_KEYS_MIN_DESKTOP).toBe("0.1.98");
    for (const v of ["0.1.98", "0.1.98-staging.1", "0.1.98-staging.244", "0.1.99", "0.2.0"]) {
      expect(isVaultKeyCapableVersion(v)).toBe(true);
    }
  });

  it("refuses older builds, their staging builds and a missing version", () => {
    for (const v of ["0.1.97", "0.1.97-staging.5", "0.1.49", "", "garbage", undefined, null]) {
      expect(isVaultKeyCapableVersion(v)).toBe(false);
    }
  });
});
