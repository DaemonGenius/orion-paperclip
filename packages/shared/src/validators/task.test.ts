import { describe, expect, it } from "vitest";
import {
  addTaskCommentSchema,
  createTaskSchema,
  respondTaskThreadInteractionSchema,
  suggestedTaskDraftSchema,
  updateTaskSchema,
  upsertTaskDocumentSchema,
} from "./task.js";

describe("task validators", () => {
  it("passes real line breaks through unchanged", () => {
    const parsed = createTaskSchema.parse({
      title: "Follow up PR",
      description: "Line 1\n\nLine 2",
    });

    expect(parsed.description).toBe("Line 1\n\nLine 2");
  });

  it("accepts null and omitted optional multiline task fields", () => {
    expect(createTaskSchema.parse({ title: "Follow up PR", description: null }).description)
      .toBeNull();
    expect(createTaskSchema.parse({ title: "Follow up PR" }).description)
      .toBeUndefined();
    expect(updateTaskSchema.parse({ comment: undefined }).comment)
      .toBeUndefined();
  });

  it("normalizes JSON-escaped line breaks in task descriptions", () => {
    const parsed = createTaskSchema.parse({
      title: "Follow up PR",
      description: "PR: https://example.com/pr/1\\n\\nShip the follow-up.",
    });

    expect(parsed.description).toBe("PR: https://example.com/pr/1\n\nShip the follow-up.");
  });

  it("normalizes escaped line breaks in task update comments", () => {
    const parsed = updateTaskSchema.parse({
      comment: "Done\\n\\n- Verified the route",
    });

    expect(parsed.comment).toBe("Done\n\n- Verified the route");
  });

  it("normalizes escaped line breaks in task comment bodies", () => {
    const parsed = addTaskCommentSchema.parse({
      body: "Progress update\\r\\n\\r\\nNext action.",
    });

    expect(parsed.body).toBe("Progress update\n\nNext action.");
  });

  it("normalizes escaped line breaks in generated task drafts", () => {
    const parsed = suggestedTaskDraftSchema.parse({
      clientKey: "task-1",
      title: "Follow up",
      description: "Line 1\\n\\nLine 2",
    });

    expect(parsed.description).toBe("Line 1\n\nLine 2");
  });

  it("normalizes escaped line breaks in thread summaries and documents", () => {
    const response = respondTaskThreadInteractionSchema.parse({
      answers: [],
      summaryMarkdown: "Summary\\n\\nNext action",
    });
    const document = upsertTaskDocumentSchema.parse({
      format: "markdown",
      body: "# Plan\\n\\nShip it",
    });

    expect(response.summaryMarkdown).toBe("Summary\n\nNext action");
    expect(document.body).toBe("# Plan\n\nShip it");
  });
});
