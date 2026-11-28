import { describe, expect, it } from "vitest";
import { icons } from "@dicebear/collection";
import { groupIconFor, type GroupIconName } from "../groupIcon";
import { groupIconSvg } from "../../components/GroupIconSvg";

const icon = (name: string, id = name) => groupIconFor({ id, name });

describe("access group icons", () => {
  it("picks an icon from the group's name", () => {
    expect(icon("Design")).toBe("palette");
    expect(icon("Designers")).toBe("palette");
    expect(icon("Marketing team")).toBe("megaphone");
    expect(icon("SAles")).toBe("cashCoin");
    expect(icon("Testers")).toBe("bug");
    expect(icon("QA")).toBe("bug");
    expect(icon("Engineering")).toBe("laptop");
    expect(icon("Support")).toBe("inbox");
    expect(icon("Finance")).toBe("piggyBank");
    expect(icon("Product")).toBe("puzzle");
    expect(icon("HR")).toBe("emojiSmile");
    expect(icon("Leadership")).toBe("award");
    expect(icon("Contractors")).toBe("briefcase");
    expect(icon("Interns")).toBe("egg");
  });
  it("matches short words only whole, so 'Itinerary' is not IT", () => {
    expect(icon("Itinerary", "a")).not.toBe("laptop");
  });
  it("gives an unknown name a stable pick from its id", () => {
    expect(icon("fdsafsdfsa", "g1")).toBe(icon("renamed", "g1"));
  });
  it("only uses names DiceBear's icon set has", () => {
    const known = new Set((icons.schema.properties as { icon: { items: { enum: string[] } } }).icon.items.enum);
    const names = ["Design","Marketing","Sales","Finance","Devops","Engineering","Mobile","Support","Product","Research","Data","Legal","HR","Operations","Shipping","Leadership","Writers","News","Training","Interns","Contractors","Guests","Video","Podcast","Events","Community","Shop","Ideas","Reviewers","Pricing","Everyone","QA"];
    for (const n of names) expect(known.has(icon(n))).toBe(true);
    for (let i = 0; i < 60; i++) expect(known.has(icon("zzz", "id" + i))).toBe(true);
  });
});

describe("group icon colour", () => {
  // Every icon the picker can return. Some draw one shape whose white fill sits
  // on the path itself; the glyph must take the tint's ink, never stay white.
  const ALL: GroupIconName[] = [
    "palette", "megaphone", "cashCoin", "piggyBank", "laptop", "bug", "inbox", "puzzle",
    "binoculars", "search", "lock", "emojiSmile", "boxSeam", "award", "pen", "mortarboard",
    "briefcase", "key", "egg", "cameraReels", "ticketPerforated", "truck", "shop", "phone",
    "router", "speaker", "globe2", "houseDoor", "calculator", "handThumbsUp", "newspaper",
    "lightbulb", "star", "gem", "lightning", "flower1", "tree", "sun", "moonStars",
    "compass", "magic", "gift", "flag", "umbrella", "cup", "bicycle",
  ];
  it.each(ALL)("%s draws in currentColor, with white only in the viewbox mask", (name) => {
    const svg = groupIconSvg(name);
    expect(svg).toContain("currentColor");
    const glyph = svg.replace(/<mask[\s\S]*?<\/mask>/, "");
    expect(glyph).not.toMatch(/fill="#fff"/i);
  });
});
