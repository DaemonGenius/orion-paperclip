import { describe, expect, it } from "vitest";
import { buildWorktreeMergePlan, parseWorktreeMergeScopes } from "../commands/worktree-merge-history-lib.js";

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: "goal-1",
    parentId: null,
    title: "Task",
    description: null,
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: "local-board",
    taskNumber: 1,
    identifier: "PAP-1",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-03-20T00:00:00.000Z"),
    updatedAt: new Date("2026-03-20T00:00:00.000Z"),
    ...overrides,
  } as any;
}

function makeComment(overrides: Record<string, unknown> = {}) {
  return {
    id: "comment-1",
    companyId: "company-1",
    taskId: "task-1",
    authorAgentId: null,
    authorUserId: "local-board",
    body: "hello",
    createdAt: new Date("2026-03-20T00:00:00.000Z"),
    updatedAt: new Date("2026-03-20T00:00:00.000Z"),
    ...overrides,
  } as any;
}

function makeTaskDocument(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-document-1",
    companyId: "company-1",
    taskId: "task-1",
    documentId: "document-1",
    key: "plan",
    linkCreatedAt: new Date("2026-03-20T00:00:00.000Z"),
    linkUpdatedAt: new Date("2026-03-20T00:00:00.000Z"),
    title: "Plan",
    format: "markdown",
    latestBody: "# Plan",
    latestRevisionId: "revision-1",
    latestRevisionNumber: 1,
    createdByAgentId: null,
    createdByUserId: "local-board",
    updatedByAgentId: null,
    updatedByUserId: "local-board",
    documentCreatedAt: new Date("2026-03-20T00:00:00.000Z"),
    documentUpdatedAt: new Date("2026-03-20T00:00:00.000Z"),
    ...overrides,
  } as any;
}

function makeDocumentRevision(overrides: Record<string, unknown> = {}) {
  return {
    id: "revision-1",
    companyId: "company-1",
    documentId: "document-1",
    revisionNumber: 1,
    body: "# Plan",
    changeSummary: null,
    createdByAgentId: null,
    createdByUserId: "local-board",
    createdAt: new Date("2026-03-20T00:00:00.000Z"),
    ...overrides,
  } as any;
}

function makeAttachment(overrides: Record<string, unknown> = {}) {
  return {
    id: "attachment-1",
    companyId: "company-1",
    taskId: "task-1",
    taskCommentId: null,
    assetId: "asset-1",
    provider: "local_disk",
    objectKey: "company-1/tasks/task-1/2026/03/20/asset.png",
    contentType: "image/png",
    byteSize: 12,
    sha256: "deadbeef",
    originalFilename: "asset.png",
    createdByAgentId: null,
    createdByUserId: "local-board",
    assetCreatedAt: new Date("2026-03-20T00:00:00.000Z"),
    assetUpdatedAt: new Date("2026-03-20T00:00:00.000Z"),
    attachmentCreatedAt: new Date("2026-03-20T00:00:00.000Z"),
    attachmentUpdatedAt: new Date("2026-03-20T00:00:00.000Z"),
    ...overrides,
  } as any;
}

function makeProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "project-1",
    companyId: "company-1",
    goalId: null,
    name: "Project",
    description: null,
    status: "in_progress",
    leadAgentId: null,
    targetDate: null,
    color: "#22c55e",
    pauseReason: null,
    pausedAt: null,
    executionWorkspacePolicy: null,
    archivedAt: null,
    createdAt: new Date("2026-03-20T00:00:00.000Z"),
    updatedAt: new Date("2026-03-20T00:00:00.000Z"),
    ...overrides,
  } as any;
}

function makeProjectWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    id: "workspace-1",
    companyId: "company-1",
    projectId: "project-1",
    name: "Workspace",
    sourceType: "local_path",
    cwd: "/tmp/project",
    repoUrl: "https://github.com/example/project.git",
    repoRef: "main",
    defaultRef: "main",
    visibility: "default",
    setupCommand: null,
    cleanupCommand: null,
    remoteProvider: null,
    remoteWorkspaceRef: null,
    sharedWorkspaceKey: null,
    metadata: null,
    isPrimary: true,
    createdAt: new Date("2026-03-20T00:00:00.000Z"),
    updatedAt: new Date("2026-03-20T00:00:00.000Z"),
    ...overrides,
  } as any;
}

describe("worktree merge history planner", () => {
  it("parses default scopes", () => {
    expect(parseWorktreeMergeScopes(undefined)).toEqual(["tasks", "comments"]);
    expect(parseWorktreeMergeScopes("tasks")).toEqual(["tasks"]);
  });

  it("dedupes nested worktree tasks by preserved source uuid", () => {
    const sharedTask = makeTask({ id: "task-a", identifier: "PAP-10", title: "Shared" });
    const branchOneTask = makeTask({
      id: "task-b",
      identifier: "PAP-22",
      title: "Branch one task",
      createdAt: new Date("2026-03-20T01:00:00.000Z"),
    });
    const branchTwoTask = makeTask({
      id: "task-c",
      identifier: "PAP-23",
      title: "Branch two task",
      createdAt: new Date("2026-03-20T02:00:00.000Z"),
    });

    const plan = buildWorktreeMergePlan({
      companyId: "company-1",
      companyName: "Paperclip",
      taskPrefix: "PAP",
      previewTaskCounterStart: 500,
      scopes: ["tasks", "comments"],
      sourceTasks: [sharedTask, branchOneTask, branchTwoTask],
      targetTasks: [sharedTask, branchOneTask],
      sourceComments: [],
      targetComments: [],
      targetAgents: [],
      targetProjects: [],
      targetProjectWorkspaces: [],
      targetGoals: [{ id: "goal-1" }] as any,
    });

    expect(plan.counts.tasksToInsert).toBe(1);
    expect(plan.taskPlans.filter((item) => item.action === "insert").map((item) => item.source.id)).toEqual(["task-c"]);
    expect(plan.taskPlans.find((item) => item.source.id === "task-c" && item.action === "insert")).toMatchObject({
      previewIdentifier: "PAP-501",
    });
  });

  it("clears missing references and coerces in_progress without an assignee", () => {
    const plan = buildWorktreeMergePlan({
      companyId: "company-1",
      companyName: "Paperclip",
      taskPrefix: "PAP",
      previewTaskCounterStart: 10,
      scopes: ["tasks"],
      sourceTasks: [
        makeTask({
          id: "task-x",
          identifier: "PAP-99",
          status: "in_progress",
          assigneeAgentId: "agent-missing",
          projectId: "project-missing",
          projectWorkspaceId: "workspace-missing",
          goalId: "goal-missing",
        }),
      ],
      targetTasks: [],
      sourceComments: [],
      targetComments: [],
      targetAgents: [],
      targetProjects: [],
      targetProjectWorkspaces: [],
      targetGoals: [],
    });

    const insert = plan.taskPlans[0] as any;
    expect(insert.targetStatus).toBe("todo");
    expect(insert.targetAssigneeAgentId).toBeNull();
    expect(insert.targetProjectId).toBeNull();
    expect(insert.targetProjectWorkspaceId).toBeNull();
    expect(insert.targetGoalId).toBeNull();
    expect(insert.adjustments).toEqual([
      "clear_assignee_agent",
      "clear_project",
      "clear_project_workspace",
      "clear_goal",
      "coerce_in_progress_to_todo",
    ]);
  });

  it("applies an explicit project mapping override instead of clearing the project", () => {
    const plan = buildWorktreeMergePlan({
      companyId: "company-1",
      companyName: "Paperclip",
      taskPrefix: "PAP",
      previewTaskCounterStart: 10,
      scopes: ["tasks"],
      sourceTasks: [
        makeTask({
          id: "task-project-map",
          identifier: "PAP-77",
          projectId: "source-project-1",
          projectWorkspaceId: "source-workspace-1",
        }),
      ],
      targetTasks: [],
      sourceComments: [],
      targetComments: [],
      targetAgents: [],
      targetProjects: [{ id: "target-project-1", name: "Mapped project", status: "in_progress" }] as any,
      targetProjectWorkspaces: [],
      targetGoals: [{ id: "goal-1" }] as any,
      projectIdOverrides: {
        "source-project-1": "target-project-1",
      },
    });

    const insert = plan.taskPlans[0] as any;
    expect(insert.targetProjectId).toBe("target-project-1");
    expect(insert.projectResolution).toBe("mapped");
    expect(insert.mappedProjectName).toBe("Mapped project");
    expect(insert.targetProjectWorkspaceId).toBeNull();
    expect(insert.adjustments).toEqual(["clear_project_workspace"]);
  });

  it("plans selected project imports and preserves project workspace links", () => {
    const sourceProject = makeProject({
      id: "source-project-1",
      name: "Paperclip Evals",
      goalId: "goal-1",
    });
    const sourceWorkspace = makeProjectWorkspace({
      id: "source-workspace-1",
      projectId: "source-project-1",
      cwd: "/Users/dotta/paperclip-evals",
      repoUrl: "https://github.com/paperclipai/paperclip-evals.git",
    });

    const plan = buildWorktreeMergePlan({
      companyId: "company-1",
      companyName: "Paperclip",
      taskPrefix: "PAP",
      previewTaskCounterStart: 10,
      scopes: ["tasks"],
      sourceTasks: [
        makeTask({
          id: "task-project-import",
          identifier: "PAP-88",
          projectId: "source-project-1",
          projectWorkspaceId: "source-workspace-1",
        }),
      ],
      targetTasks: [],
      sourceComments: [],
      targetComments: [],
      sourceProjects: [sourceProject],
      sourceProjectWorkspaces: [sourceWorkspace],
      targetAgents: [],
      targetProjects: [],
      targetProjectWorkspaces: [],
      targetGoals: [{ id: "goal-1" }] as any,
      importProjectIds: ["source-project-1"],
    });

    expect(plan.counts.projectsToImport).toBe(1);
    expect(plan.projectImports[0]).toMatchObject({
      source: { id: "source-project-1", name: "Paperclip Evals" },
      targetGoalId: "goal-1",
      workspaces: [{ id: "source-workspace-1" }],
    });

    const insert = plan.taskPlans[0] as any;
    expect(insert.targetProjectId).toBe("source-project-1");
    expect(insert.targetProjectWorkspaceId).toBe("source-workspace-1");
    expect(insert.projectResolution).toBe("imported");
    expect(insert.mappedProjectName).toBe("Paperclip Evals");
    expect(insert.adjustments).toEqual([]);
  });

  it("imports comments onto shared or newly imported tasks while skipping existing comments", () => {
    const sharedTask = makeTask({ id: "task-a", identifier: "PAP-10" });
    const newTask = makeTask({
      id: "task-b",
      identifier: "PAP-11",
      createdAt: new Date("2026-03-20T01:00:00.000Z"),
    });
    const existingComment = makeComment({ id: "comment-existing", taskId: "task-a" });
    const sharedTaskComment = makeComment({ id: "comment-shared", taskId: "task-a" });
    const newTaskComment = makeComment({
      id: "comment-new-task",
      taskId: "task-b",
      authorAgentId: "missing-agent",
      createdAt: new Date("2026-03-20T01:05:00.000Z"),
    });

    const plan = buildWorktreeMergePlan({
      companyId: "company-1",
      companyName: "Paperclip",
      taskPrefix: "PAP",
      previewTaskCounterStart: 10,
      scopes: ["tasks", "comments"],
      sourceTasks: [sharedTask, newTask],
      targetTasks: [sharedTask],
      sourceComments: [existingComment, sharedTaskComment, newTaskComment],
      targetComments: [existingComment],
      targetAgents: [],
      targetProjects: [],
      targetProjectWorkspaces: [],
      targetGoals: [{ id: "goal-1" }] as any,
    });

    expect(plan.counts.commentsToInsert).toBe(2);
    expect(plan.counts.commentsExisting).toBe(1);
    expect(plan.commentPlans.filter((item) => item.action === "insert").map((item) => item.source.id)).toEqual([
      "comment-shared",
      "comment-new-task",
    ]);
    expect(plan.adjustments.clear_author_agent).toBe(1);
  });

  it("merges document revisions onto an existing shared document and renumbers conflicts", () => {
    const sharedTask = makeTask({ id: "task-a", identifier: "PAP-10" });
    const sourceDocument = makeTaskDocument({
      taskId: "task-a",
      documentId: "document-a",
      latestBody: "# Branch plan",
      latestRevisionId: "revision-branch-2",
      latestRevisionNumber: 2,
      documentUpdatedAt: new Date("2026-03-20T02:00:00.000Z"),
      linkUpdatedAt: new Date("2026-03-20T02:00:00.000Z"),
    });
    const targetDocument = makeTaskDocument({
      taskId: "task-a",
      documentId: "document-a",
      latestBody: "# Main plan",
      latestRevisionId: "revision-main-2",
      latestRevisionNumber: 2,
      documentUpdatedAt: new Date("2026-03-20T01:00:00.000Z"),
      linkUpdatedAt: new Date("2026-03-20T01:00:00.000Z"),
    });
    const sourceRevisionOne = makeDocumentRevision({ documentId: "document-a", id: "revision-1" });
    const sourceRevisionTwo = makeDocumentRevision({
      documentId: "document-a",
      id: "revision-branch-2",
      revisionNumber: 2,
      body: "# Branch plan",
      createdAt: new Date("2026-03-20T02:00:00.000Z"),
    });
    const targetRevisionOne = makeDocumentRevision({ documentId: "document-a", id: "revision-1" });
    const targetRevisionTwo = makeDocumentRevision({
      documentId: "document-a",
      id: "revision-main-2",
      revisionNumber: 2,
      body: "# Main plan",
      createdAt: new Date("2026-03-20T01:00:00.000Z"),
    });

    const plan = buildWorktreeMergePlan({
      companyId: "company-1",
      companyName: "Paperclip",
      taskPrefix: "PAP",
      previewTaskCounterStart: 10,
      scopes: ["tasks", "comments"],
      sourceTasks: [sharedTask],
      targetTasks: [sharedTask],
      sourceComments: [],
      targetComments: [],
      sourceDocuments: [sourceDocument],
      targetDocuments: [targetDocument],
      sourceDocumentRevisions: [sourceRevisionOne, sourceRevisionTwo],
      targetDocumentRevisions: [targetRevisionOne, targetRevisionTwo],
      sourceAttachments: [],
      targetAttachments: [],
      targetAgents: [],
      targetProjects: [],
      targetProjectWorkspaces: [],
      targetGoals: [{ id: "goal-1" }] as any,
    });

    expect(plan.counts.documentsToMerge).toBe(1);
    expect(plan.counts.documentRevisionsToInsert).toBe(1);
    expect(plan.documentPlans[0]).toMatchObject({
      action: "merge_existing",
      latestRevisionId: "revision-branch-2",
      latestRevisionNumber: 3,
    });
    const mergePlan = plan.documentPlans[0] as any;
    expect(mergePlan.revisionsToInsert).toHaveLength(1);
    expect(mergePlan.revisionsToInsert[0]).toMatchObject({
      source: { id: "revision-branch-2" },
      targetRevisionNumber: 3,
    });
  });

  it("imports attachments while clearing missing comment and author references", () => {
    const sharedTask = makeTask({ id: "task-a", identifier: "PAP-10" });
    const attachment = makeAttachment({
      taskId: "task-a",
      taskCommentId: "comment-missing",
      createdByAgentId: "agent-missing",
    });

    const plan = buildWorktreeMergePlan({
      companyId: "company-1",
      companyName: "Paperclip",
      taskPrefix: "PAP",
      previewTaskCounterStart: 10,
      scopes: ["tasks"],
      sourceTasks: [sharedTask],
      targetTasks: [sharedTask],
      sourceComments: [],
      targetComments: [],
      sourceDocuments: [],
      targetDocuments: [],
      sourceDocumentRevisions: [],
      targetDocumentRevisions: [],
      sourceAttachments: [attachment],
      targetAttachments: [],
      targetAgents: [],
      targetProjects: [],
      targetProjectWorkspaces: [],
      targetGoals: [{ id: "goal-1" }] as any,
    });

    expect(plan.counts.attachmentsToInsert).toBe(1);
    expect(plan.adjustments.clear_attachment_agent).toBe(1);
    expect(plan.attachmentPlans[0]).toMatchObject({
      action: "insert",
      targetTaskCommentId: null,
      targetCreatedByAgentId: null,
    });
  });
});
