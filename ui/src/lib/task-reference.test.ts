import { describe, expect, it } from "vitest";
import { parseTaskPathIdFromPath, parseTaskReferenceFromHref } from "./task-reference";

describe("task-reference", () => {
  it("extracts task ids from company-scoped task paths", () => {
    expect(parseTaskPathIdFromPath("/PAP/tasks/PAP-1271")).toBe("PAP-1271");
    expect(parseTaskPathIdFromPath("/PAP/tasks/pap-1272")).toBe("PAP-1272");
    expect(parseTaskPathIdFromPath("/tasks/PAP-1179")).toBe("PAP-1179");
    expect(parseTaskPathIdFromPath("/tasks/:id")).toBeNull();
  });

  it("does not treat full task URLs as internal task paths", () => {
    expect(parseTaskPathIdFromPath("http://localhost:3100/PAP/tasks/PAP-1179")).toBeNull();
    expect(parseTaskPathIdFromPath("http://remote.example.test:3103/PAPA/tasks/PAPA-115#comment-850083f3-24de-43e7-a8cd-bc01f7cc9f0d")).toBeNull();
  });

  it("does not treat GitHub task URLs as internal Paperclip task links", () => {
    expect(parseTaskPathIdFromPath("https://github.com/paperclipai/paperclip/tasks/1778")).toBeNull();
    expect(parseTaskReferenceFromHref("https://github.com/paperclipai/paperclip/tasks/1778")).toBeNull();
  });

  it("ignores placeholder task paths", () => {
    expect(parseTaskPathIdFromPath("/tasks/:id")).toBeNull();
    expect(parseTaskPathIdFromPath("http://localhost:3100/tasks/:id")).toBeNull();
    expect(parseTaskReferenceFromHref("/tasks/:id")).toBeNull();
  });

  it("normalizes bare identifiers, relative task paths, and task scheme links into internal links", () => {
    expect(parseTaskReferenceFromHref("pap-1271")).toEqual({
      taskPathId: "PAP-1271",
      href: "/tasks/PAP-1271",
    });
    expect(parseTaskReferenceFromHref("/PAP/tasks/pap-1180")).toEqual({
      taskPathId: "PAP-1180",
      href: "/tasks/PAP-1180",
    });
    expect(parseTaskReferenceFromHref("task://PAP-1310")).toEqual({
      taskPathId: "PAP-1310",
      href: "/tasks/PAP-1310",
    });
    expect(parseTaskReferenceFromHref("task://:PAP-1311")).toEqual({
      taskPathId: "PAP-1311",
      href: "/tasks/PAP-1311",
    });
  });

  it("normalizes exact inline-code-like task identifiers", () => {
    expect(parseTaskReferenceFromHref("PAP-1271")).toEqual({
      taskPathId: "PAP-1271",
      href: "/tasks/PAP-1271",
    });
  });

  it("preserves absolute Paperclip task URLs so origin, port, and hash are not lost", () => {
    expect(parseTaskReferenceFromHref("http://localhost:3100/PAP/tasks/PAP-1179")).toBeNull();
    expect(parseTaskReferenceFromHref("http://remote.example.test:3103/PAPA/tasks/PAPA-115#comment-850083f3-24de-43e7-a8cd-bc01f7cc9f0d")).toBeNull();
  });

  it("ignores literal route placeholder paths", () => {
    expect(parseTaskReferenceFromHref("/tasks/:id")).toBeNull();
    expect(parseTaskReferenceFromHref("http://localhost:3100/api/tasks/:id")).toBeNull();
  });
});
