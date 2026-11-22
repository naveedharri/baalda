import { describe, expect, it } from "vitest";
import { icons } from "@dicebear/collection";
import { groupIconFor } from "../groupIcon";

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
