import { describe, expect, it } from "vitest";
import { ApiError, type Organization } from "../api";
import { createWithUniqueSlug, isSlugConflict, slugifyName } from "../orgSlug";

function org(slug: string): Organization {
  return { id: `id-${slug}`, name: "BenAI", slug };
}

describe("slugifyName", () => {
  it("lowercases and dashes non-alphanumerics", () => {
    expect(slugifyName("BenAI")).toBe("benai");
    expect(slugifyName("My Team!!")).toBe("my-team");
    expect(slugifyName("  Hello  World  ")).toBe("hello-world");
  });
  it("falls back to 'vault' for empty results", () => {
    expect(slugifyName("###")).toBe("vault");
    expect(slugifyName("")).toBe("vault");
  });
});

describe("isSlugConflict", () => {
  it("recognizes slug-uniqueness collisions", () => {
    // Better Auth's actual duplicate-slug error (crud-org: BAD_REQUEST 400).
    expect(isSlugConflict(new ApiError(400, "Organization already exists"))).toBe(true);
    expect(
      isSlugConflict(new ApiError(400, "x", { code: "ORGANIZATION_ALREADY_EXISTS" })),
    ).toBe(true);
    expect(isSlugConflict(new ApiError(400, "slug is already taken"))).toBe(true);
    expect(isSlugConflict(new ApiError(409, "duplicate key"))).toBe(true);
    expect(isSlugConflict(new ApiError(422, "x", { code: "SLUG_EXISTS" }))).toBe(true);
  });
  it("ignores unrelated errors", () => {
    expect(isSlugConflict(new ApiError(500, "server exploded"))).toBe(false);
    expect(isSlugConflict(new ApiError(401, "unauthenticated"))).toBe(false);
    expect(isSlugConflict(new Error("network"))).toBe(false);
  });
});

describe("createWithUniqueSlug", () => {
  it("uses the clean slug when it's free", async () => {
    const seen: string[] = [];
    const result = await createWithUniqueSlug("BenAI", async ({ slug }) => {
      seen.push(slug);
      return org(slug);
    });
    expect(seen).toEqual(["benai"]);
    expect(result.slug).toBe("benai");
  });

  it("retries with a suffix on a slug collision so duplicate names still succeed", async () => {
    const taken = new Set(["benai"]);
    const seen: string[] = [];
    let n = 0;
    const result = await createWithUniqueSlug(
      "BenAI",
      async ({ slug }) => {
        seen.push(slug);
        if (taken.has(slug)) throw new ApiError(400, "slug is already taken");
        return org(slug);
      },
      () => `s${n++}`, // deterministic suffix
    );
    expect(seen[0]).toBe("benai"); // tried the clean slug first
    expect(result.slug).toBe("benai-s0"); // then succeeded with a suffix
    expect(result.id).toBe("id-benai-s0"); // identity is the unique id
  });

  it("propagates non-collision errors without retrying", async () => {
    let attempts = 0;
    await expect(
      createWithUniqueSlug("BenAI", async () => {
        attempts++;
        throw new ApiError(500, "server exploded");
      }),
    ).rejects.toMatchObject({ status: 500 });
    expect(attempts).toBe(1);
  });

  it("gives up after several collisions rather than looping forever", async () => {
    let attempts = 0;
    await expect(
      createWithUniqueSlug(
        "BenAI",
        async () => {
          attempts++;
          throw new ApiError(409, "slug taken");
        },
        () => "x",
      ),
    ).rejects.toBeInstanceOf(ApiError);
    expect(attempts).toBe(6); // clean + 5 suffixed attempts
  });
});
