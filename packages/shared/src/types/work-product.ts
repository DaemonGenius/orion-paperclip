export type TaskWorkProductType =
  | "preview_url"
  | "runtime_service"
  | "pull_request"
  | "branch"
  | "commit"
  | "artifact"
  | "document";

export type TaskWorkProductProvider =
  | "paperclip"
  | "github"
  | "vercel"
  | "s3"
  | "custom";

export type TaskWorkProductStatus =
  | "active"
  | "ready_for_review"
  | "approved"
  | "changes_requested"
  | "merged"
  | "closed"
  | "failed"
  | "archived"
  | "draft";

export type TaskWorkProductReviewState =
  | "none"
  | "needs_board_review"
  | "approved"
  | "changes_requested";

export interface TaskWorkProduct {
  id: string;
  companyId: string;
  projectId: string | null;
  taskId: string;
  executionWorkspaceId: string | null;
  runtimeServiceId: string | null;
  type: TaskWorkProductType;
  provider: TaskWorkProductProvider | string;
  externalId: string | null;
  title: string;
  url: string | null;
  status: TaskWorkProductStatus | string;
  reviewState: TaskWorkProductReviewState;
  isPrimary: boolean;
  healthStatus: "unknown" | "healthy" | "unhealthy";
  summary: string | null;
  metadata: Record<string, unknown> | null;
  createdByRunId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
