import type { TaskPriority, TaskStatus } from "./constants.js";

export const NOTION_TASK_PROPERTY_NAMES = {
  taskKey: "Task Key",
  task: "Task",
  acceptanceCriteria: "Acceptance Criteria",
  blockedBy: "Blocked By",
  dueDate: "Due Date",
  layer: "Layer",
  module: "Module",
  repoPath: "Repo Path",
  riskLevel: "Risk Level",
  sprintPhase: "Sprint Phase",
  type: "Type",
  routeMode: "Route Mode",
  reqId: "REQ ID",
  prState: "PR State",
  prUrl: "PR URL",
  agentConfidenceLevel: "Agent Confidence Level",
  wikiDocs: "Wiki Docs",
  implementationPlans: "Implementation Plans",
  reviewChecks: "Review Checks",
  decisions: "Decisions",
} as const;

export const NOTION_TASK_RELATION_PROPERTY_NAMES = [
  NOTION_TASK_PROPERTY_NAMES.wikiDocs,
  NOTION_TASK_PROPERTY_NAMES.implementationPlans,
  NOTION_TASK_PROPERTY_NAMES.reviewChecks,
  NOTION_TASK_PROPERTY_NAMES.decisions,
] as const;

export type NotionTaskRelationPropertyName = (typeof NOTION_TASK_RELATION_PROPERTY_NAMES)[number];
export type NotionTaskRouteMode = "pair" | "auto_to_pr" | "manual_review" | "blocked" | "replan";

export const NOTION_TASK_STATUS_OPTIONS = [
  "Backlog",
  "Ready",
  "In Progress",
  "Review",
  "Blocked",
  "Done",
  "Deferred",
] as const;

export const NOTION_TASK_PRIORITY_OPTIONS = [
  "P0 Critical",
  "P1 High",
  "P2 Medium",
  "P3 Low",
] as const;

export const NOTION_TASK_ROUTE_MODE_OPTIONS = [
  "Pair",
  "Auto",
  "Auto-to-PR",
  "Manual Review",
  "Blocked",
  "Replan",
] as const;

export function normalizeNotionTaskPropertyName(value: string) {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, " ");
}

export function mapNotionTaskStatus(value: string | null | undefined): TaskStatus {
  switch (normalizeNotionTaskPropertyName(value ?? "")) {
    case "backlog": return "backlog";
    case "ready": return "todo";
    case "in progress": return "in_progress";
    case "review": return "in_review";
    case "blocked": return "blocked";
    case "done": return "done";
    case "deferred": return "cancelled";
    default: return "backlog";
  }
}

export function mapNotionTaskPriority(value: string | null | undefined): TaskPriority {
  switch (normalizeNotionTaskPropertyName(value ?? "")) {
    case "p0 critical": return "critical";
    case "p1 high": return "high";
    case "p2 medium": return "medium";
    case "p3 low": return "low";
    default: return "medium";
  }
}

export function mapNotionTaskRouteMode(value: string | null | undefined): NotionTaskRouteMode | null {
  switch (normalizeNotionTaskPropertyName(value ?? "")) {
    case "pair": return "pair";
    case "auto":
    case "auto to pr":
    case "auto-to-pr": return "auto_to_pr";
    case "manual review": return "manual_review";
    case "blocked": return "blocked";
    case "replan": return "replan";
    default: return null;
  }
}
