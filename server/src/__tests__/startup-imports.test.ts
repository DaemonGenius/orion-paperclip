import { describe, expect, it } from "vitest";

describe("startup import guards", () => {
  it("loads Orion routes with shared root exports available", async () => {
    try {
      const module = await import("../routes/orion.js");
      expect(module.orionRoutes).toEqual(expect.any(Function));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Orion route startup import failed. Check that every symbol imported from @paperclipai/shared is exported from packages/shared/src/index.ts. Original error: ${message}`,
      );
    }
  });
});
