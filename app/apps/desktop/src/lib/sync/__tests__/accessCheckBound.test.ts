import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ACCESS_CHECK_MAX } from "../../api";

/**
 * The client's `ACCESS_CHECK_MAX` must equal the server's.
 *
 * They live in separate packages with no dependency between them, so the value
 * is mirrored rather than imported — and a silent drift is not cosmetic. The
 * route answers 400 above its own bound, and `confirmRevocations` reads a 400 as
 * "no answer, remove nothing". A client chunking to a larger number would turn
 * every revocation on a vault that big into a permanent failure, repeating on
 * every connect and never landing.
 *
 * Read from the server source rather than imported, because importing across the
 * workspace boundary would make the desktop build depend on the server package.
 */
describe("ACCESS_CHECK_MAX", () => {
  it("matches the server's declared bound", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const serverRoute = resolve(here, "../../../../../server/src/http/routes/registry.ts");
    const src = readFileSync(serverRoute, "utf8");
    const m = /export const ACCESS_CHECK_MAX = (\d+);/.exec(src);
    expect(m, `no ACCESS_CHECK_MAX declaration found in ${serverRoute}`).not.toBeNull();
    expect(Number(m![1])).toBe(ACCESS_CHECK_MAX);
  });
});
