import { describe, expect, test } from "bun:test";
import { slugify } from "../src/slug";

describe("slugify", () => {
  test("lowercases and joins words with dashes", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  test("drops punctuation and trims dashes", () => {
    expect(slugify("  Hello, World!  ")).toBe("hello-world");
  });

  test("returns an empty string when nothing is left", () => {
    expect(slugify("!!!")).toBe("");
  });
});
