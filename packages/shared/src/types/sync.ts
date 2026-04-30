export type SyncProvider = "notion" | "obsidian";

export type SyncOwnerClass = "operator_owned" | "system_owned" | "knowledge_owned" | "proposal_only";

export type SyncStatus = "synced" | "pending" | "conflict" | "error";

export interface ExternalObjectRef {
  id: string;
  companyId: string;
  provider: SyncProvider;
  localObjectType: string;
  localObjectId: string;
  externalObjectId: string;
  externalUrl: string | null;
  ownerClass: SyncOwnerClass;
  checksum: string;
  metadata: Record<string, unknown>;
  lastExternalEditedAt: Date | null;
  lastOrionEditedAt: Date | null;
  syncStatus: SyncStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface SyncCursor {
  id: string;
  companyId: string;
  provider: SyncProvider;
  scope: string;
  cursorJson: Record<string, unknown>;
  status: string;
  lastSyncedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SyncConflict {
  id: string;
  companyId: string;
  provider: SyncProvider;
  localObjectType: string;
  localObjectId: string;
  externalObjectId: string | null;
  status: string;
  conflictJson: Record<string, unknown>;
  decisionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface KnowledgeProposal {
  id: string;
  companyId: string;
  provider: SyncProvider;
  sourceObjectRefId: string | null;
  targetPath: string;
  status: string;
  title: string;
  body: string | null;
  proposedBody: string | null;
  metadata: Record<string, unknown>;
  resolvedByUserId: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ObsidianIndexResult {
  provider: "obsidian";
  indexedAt: string;
  vaultPath: string;
  scannedFiles: number;
  indexedFiles: number;
  skippedFiles: number;
  refs: ExternalObjectRef[];
}

export interface NotionKnowledgeSyncResult {
  provider: "notion";
  syncedAt: string;
  rootPageId: string;
  discoveredObjects: number;
  syncedRefs: number;
  mirroredFiles: number;
  exportedDatabaseRows: number;
  importedTasks: number;
  importedProjects: number;
  refs: ExternalObjectRef[];
  obsidianRefs: ExternalObjectRef[];
}

export interface NotionKnowledgeSyncJobStatus {
  provider: "notion";
  scope: "knowledge_root";
  status: "idle" | "queued" | "running" | "completed" | "error";
  jobId: string | null;
  stage: string | null;
  message: string | null;
  progress: {
    current: number;
    total: number | null;
  };
  result: Omit<NotionKnowledgeSyncResult, "refs" | "obsidianRefs"> | null;
  error: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  lastSyncedAt: string | null;
}

export interface StartNotionKnowledgeSyncResult {
  started: boolean;
  status: NotionKnowledgeSyncJobStatus;
}

export interface KnowledgeClearResult {
  clearedRefs: number;
  removedMirrorFiles: number;
  deletedImportedTasks: number;
  deletedImportedProjects: number;
  deletedKnowledgeProposals: number;
  deletedSyncConflicts: number;
  clearedSyncCursors: number;
  skippedProjects: Array<{
    projectId: string;
    projectName: string;
    reason: string;
  }>;
}

export interface NotionTaskSyncRef {
  provider: "notion";
  notionPageId: string;
  taskId: string;
  syncStatus: SyncStatus;
  refId: string;
}

export type CompanyKnowledgeSectionKey =
  | "wiki"
  | "decisions"
  | "standards"
  | "operating_context";

export interface CompanyKnowledgeSection {
  key: CompanyKnowledgeSectionKey;
  title: string;
  localObjectType: string;
  ownerClass: SyncOwnerClass;
  ref: ExternalObjectRef;
}

export interface CompanyKnowledgeStructure {
  provider: "notion";
  companyId: string;
  companyName: string;
  root: ExternalObjectRef;
  sections: CompanyKnowledgeSection[];
}

export type ProjectWorkspaceSectionKey =
  | "goals_roadmap"
  | "tasks"
  | "wiki"
  | "implementation_plans"
  | "decision_log"
  | "review_checklist";

export interface ProjectWorkspaceSection {
  key: ProjectWorkspaceSectionKey;
  title: string;
  localObjectType: string;
  ownerClass: SyncOwnerClass;
  ref: ExternalObjectRef;
}

export interface ProjectWorkspaceStructure {
  provider: "notion";
  projectId: string;
  projectName: string;
  root: ExternalObjectRef;
  sections: ProjectWorkspaceSection[];
}
