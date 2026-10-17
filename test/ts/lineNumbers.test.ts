import { describe, expect, it } from "vitest";
import { indexToLine, lineToIndex } from "../../src/lineNumbers";

describe("line numbers", () => {
  it("converts 1-based lines to 0-based indexes", () => {
    expect(lineToIndex(1)).toBe(0);
    expect(lineToIndex(42)).toBe(41);
    expect(lineToIndex(0)).toBe(0);
  });

  it("converts 0-based indexes to 1-based lines", () => {
    expect(indexToLine(0)).toBe(1);
    expect(indexToLine(41)).toBe(42);
  });
});
