import type { TaskPriority, TaskStatus } from "../constants.js";

export interface UserProfileIdentity {
  id: string;
  slug: string;
  name: string | null;
  email: string | null;
  image: string | null;
  membershipRole: string | null;
  membershipStatus: string;
  joinedAt: Date;
}

export interface UserProfileWindowStats {
  key: "last7" | "last30" | "all";
  label: string;
  touchedTasks: number;
  createdTasks: number;
  completedTasks: number;
  assignedOpenTasks: number;
  commentCount: number;
  activityCount: number;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costEventCount: number;
}

export interface UserProfileDailyPoint {
  date: string;
  activityCount: number;
  completedTasks: number;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface UserProfileTaskSummary {
  id: string;
  identifier: string | null;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  updatedAt: Date;
  completedAt: Date | null;
}

export interface UserProfileActivitySummary {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown> | null;
  createdAt: Date;
}

export interface UserProfileAgentUsage {
  agentId: string;
  agentName: string | null;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface UserProfileProviderUsage {
  provider: string;
  biller: string;
  model: string;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface UserProfileResponse {
  user: UserProfileIdentity;
  stats: UserProfileWindowStats[];
  daily: UserProfileDailyPoint[];
  recentTasks: UserProfileTaskSummary[];
  recentActivity: UserProfileActivitySummary[];
  topAgents: UserProfileAgentUsage[];
  topProviders: UserProfileProviderUsage[];
}
