// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { Avatar, FaceSvg, characterSvg } from "../Avatar";
import VaultIconSvg from "../VaultIconSvg";
import {
  rememberAvatarImage,
  resetAvatarImages,
  resolveAvatar,
  setSelfAvatarImage,
  wireAvatarImage,
} from "../../lib/avatarIdentity";
import { presenceUser } from "../../lib/presence/color";

const USER = "vkZI6mlNCOsJYGAeGpEoSiPsOOygr1wl";
const NAME = "Test User cfdasf";

/** The account bar's avatar (AccountMenu → LazyAvatar → Avatar). */
const accountBar = (image: string | null) =>
  renderToStaticMarkup(createElement(Avatar, { label: NAME, image, userId: USER }));

/** The presence stack/roster face, fed only what awareness carries. */
const presence = (wire: { id?: string; name?: string; image?: string }) =>
  renderToStaticMarkup(
    createElement(FaceSvg, { userId: wire.id, name: wire.name, image: wire.image, className: "presence-avatar" }),
  );

// Compare character art, independent of each mounted SVG's resource namespace.
const svgOf = (html: string) => html.slice(html.indexOf("<svg"), html.lastIndexOf("</svg>") + 6)
  .replace(/baalda-svg-[A-Za-z0-9_-]+?--/g, "");

afterEach(() => {
  resetAvatarImages();
  setSelfAvatarImage(null, null);
});

describe("one avatar rule on every surface", () => {
  it("isolates masks between vault icons, account faces, and repeated gallery characters", () => {
    const html = renderToStaticMarkup(createElement("div", null,
      createElement(VaultIconSvg, { icon: "book", color: "purple" }),
      createElement(Avatar, { label: NAME, userId: USER }),
      createElement(FaceSvg, { userId: USER, className: "presence-avatar" }),
      createElement(Avatar, { label: NAME, image: "character:baalda-3" }),
      createElement(Avatar, { label: NAME, image: "character:baalda-3" }),
    ));
    const host = document.createElement("div");
    host.innerHTML = html;
    const ids = [...host.querySelectorAll("svg [id]")].map((element) => element.id);
    expect(ids.length).toBeGreaterThanOrEqual(5);
    expect(new Set(ids).size).toBe(ids.length);
    for (const svg of host.querySelectorAll("svg")) {
      const localIds = new Set([...svg.querySelectorAll("[id]")].map((element) => element.id));
      for (const match of svg.outerHTML.matchAll(/url\(#([^\)]+)\)/g)) {
        expect(localIds.has(match[1])).toBe(true);
      }
    }
    const repeated = [...host.querySelectorAll(".avatar")].slice(-2);
    expect(svgOf(repeated[0].innerHTML)).toBe(svgOf(repeated[1].innerHTML));
  });
  it("seeds the generated face by user id, never by name", () => {
    expect(resolveAvatar({ userId: USER, name: NAME })).toEqual({ photo: null, seed: USER });
    expect(svgOf(accountBar(null))).toBe(characterSvg(USER));
    expect(svgOf(presence({ id: USER, name: NAME }))).toBe(svgOf(accountBar(null)));
    expect(svgOf(accountBar(null))).not.toBe(characterSvg(NAME));
  });

  it("draws a picked character identically in the account bar and the presence row", () => {
    setSelfAvatarImage(USER, "character:baalda-3");
    const wire = presenceUser(USER, NAME);
    expect(wire.image).toBe("character:baalda-3");
    expect(svgOf(presence(wire))).toBe(svgOf(accountBar("character:baalda-3")));
    expect(svgOf(accountBar("character:baalda-3"))).toBe(characterSvg("baalda-3"));
  });

  it("fills a missing presence picture from the directory", () => {
    rememberAvatarImage(USER, "character:baalda-7");
    expect(svgOf(presence({ id: USER, name: NAME }))).toBe(characterSvg("baalda-7"));
  });

  it("lets an uploaded photo win over the generated face", () => {
    const photo = "https://lh3.googleusercontent.com/a/photo";
    expect(accountBar(photo)).toContain(`src="${photo}"`);
    expect(accountBar(photo)).not.toContain("<svg");
    expect(presence({ id: USER, name: NAME, image: photo })).toContain(`src="${photo}"`);
    rememberAvatarImage(USER, photo);
    expect(presence({ id: USER, name: NAME })).toContain(`src="${photo}"`);
  });

  it("keeps big data: uploads off the presence wire but still shows them locally", () => {
    const upload = `data:image/png;base64,${"A".repeat(4000)}`;
    expect(wireAvatarImage(upload)).toBeUndefined();
    setSelfAvatarImage(USER, upload);
    expect(presenceUser(USER, NAME).image).toBeUndefined();
    expect(presence({ id: USER, name: NAME })).toContain("data:image/png");
  });

  it("falls back without throwing for an old-build peer with no id or picture", () => {
    expect(() => presence({ name: NAME })).not.toThrow();
    expect(svgOf(presence({ name: NAME }))).toBe(characterSvg(NAME));
    expect(svgOf(presence({}))).toBe(characterSvg("?"));
    expect(presenceUser(USER, NAME)).toEqual({ id: USER, name: NAME, color: presenceUser(USER, NAME).color });
  });
});
