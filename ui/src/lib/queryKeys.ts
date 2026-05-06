export const queryKeys = {
  companies: {
    all: ["companies"] as const,
    detail: (id: string) => ["companies", id] as const,
    stats: ["companies", "stats"] as const,
  },
  orion: {
    autoTeam: (companyId: string) => ["orion", "auto-team", companyId] as const,
    councilSession: (taskId: string) => ["orion", "council-session", taskId] as const,
    reqBundle: (taskId: string) => ["orion", "req-bundle", taskId] as const,
    councilMessages: (sessionId: string) => ["orion", "council-messages", sessionId] as const,
    taskPolicy: (taskId: string) => ["orion", "task-policy", taskId] as const,
    runReadiness: (taskId: string) => ["orion", "run-readiness", taskId] as const,
    runLedger: (runId: string) => ["orion", "run-ledger", runId] as const,
    knowledgeRefs: (companyId: string, provider?: string) => ["orion", "knowledge-refs", companyId, provider ?? "all"] as const,
    notionKnowledgeSyncStatus: (companyId: string) => ["orion", "knowledge", "notion-sync-status", companyId] as const,
    knowledgeProposals: (companyId: string) => ["orion", "knowledge-proposals", companyId] as const,
    syncConflicts: (companyId: string) => ["orion", "sync-conflicts", companyId] as const,
  },
  companySkills: {
    list: (companyId: string) => ["company-skills", companyId] as const,
    detail: (companyId: string, skillId: string) => ["company-skills", companyId, skillId] as const,
    updateStatus: (companyId: string, skillId: string) =>
      ["company-skills", companyId, skillId, "update-status"] as const,
    file: (companyId: string, skillId: string, relativePath: string) =>
      ["company-skills", companyId, skillId, "file", relativePath] as const,
  },
  agents: {
    list: (companyId: string) => ["agents", companyId] as const,
    detail: (id: string) => ["agents", "detail", id] as const,
    runtimeState: (id: string) => ["agents", "runtime-state", id] as const,
    taskSessions: (id: string) => ["agents", "task-sessions", id] as const,
    skills: (id: string) => ["agents", "skills", id] as const,
    instructionsBundle: (id: string) => ["agents", "instructions-bundle", id] as const,
    instructionsFile: (id: string, relativePath: string) =>
      ["agents", "instructions-bundle", id, "file", relativePath] as const,
    keys: (agentId: string) => ["agents", "keys", agentId] as const,
    configRevisions: (agentId: string) => ["agents", "config-revisions", agentId] as const,
    adapterModels: (companyId: string, adapterType: string) =>
      ["agents", companyId, "adapter-models", adapterType] as const,
    detectModel: (companyId: string, adapterType: string) =>
      ["agents", companyId, "detect-model", adapterType] as const,
  },
  tasks: {
    list: (companyId: string) => ["tasks", companyId] as const,
    search: (companyId: string, q: string, projectId?: string, limit?: number) =>
      ["tasks", companyId, "search", q, projectId ?? "__all-projects__", limit ?? "__no-limit__"] as const,
    listAssignedToMe: (companyId: string) => ["tasks", companyId, "assigned-to-me"] as const,
    listMineByMe: (companyId: string) => ["tasks", companyId, "mine-by-me"] as const,
    listTouchedByMe: (companyId: string) => ["tasks", companyId, "touched-by-me"] as const,
    listUnreadTouchedByMe: (companyId: string) => ["tasks", companyId, "unread-touched-by-me"] as const,
    labels: (companyId: string) => ["tasks", companyId, "labels"] as const,
    listByProject: (companyId: string, projectId: string) =>
      ["tasks", companyId, "project", projectId] as const,
    listByParent: (companyId: string, parentId: string) =>
      ["tasks", companyId, "parent", parentId] as const,
    listByDescendantRoot: (companyId: string, rootTaskId: string) =>
      ["tasks", companyId, "descendants", rootTaskId] as const,
    listByExecutionWorkspace: (companyId: string, executionWorkspaceId: string) =>
      ["tasks", companyId, "execution-workspace", executionWorkspaceId] as const,
    detail: (id: string) => ["tasks", "detail", id] as const,
    comments: (taskId: string) => ["tasks", "comments", taskId] as const,
    interactions: (taskId: string) => ["tasks", "interactions", taskId] as const,
    feedbackVotes: (taskId: string) => ["tasks", "feedback-votes", taskId] as const,
    attachments: (taskId: string) => ["tasks", "attachments", taskId] as const,
    documents: (taskId: string) => ["tasks", "documents", taskId] as const,
    document: (taskId: string, key: string) => ["tasks", "document", taskId, key] as const,
    documentRevisions: (taskId: string, key: string) => ["tasks", "document-revisions", taskId, key] as const,
    activity: (taskId: string) => ["tasks", "activity", taskId] as const,
    runs: (taskId: string) => ["tasks", "runs", taskId] as const,
    approvals: (taskId: string) => ["tasks", "approvals", taskId] as const,
    liveRuns: (taskId: string) => ["tasks", "live-runs", taskId] as const,
    activeRun: (taskId: string) => ["tasks", "active-run", taskId] as const,
    workProducts: (taskId: string) => ["tasks", "work-products", taskId] as const,
  },
  routines: {
    list: (companyId: string) => ["routines", companyId] as const,
    detail: (id: string) => ["routines", "detail", id] as const,
    runs: (id: string) => ["routines", "runs", id] as const,
    activity: (companyId: string, id: string) => ["routines", "activity", companyId, id] as const,
  },
  executionWorkspaces: {
    list: (companyId: string, filters?: Record<string, string | boolean | undefined>) =>
      ["execution-workspaces", companyId, filters ?? {}] as const,
    summaryList: (companyId: string, filters?: Record<string, string | boolean | undefined>) =>
      ["execution-workspaces", companyId, "summary", filters ?? {}] as const,
    detail: (id: string) => ["execution-workspaces", "detail", id] as const,
    closeReadiness: (id: string) => ["execution-workspaces", "close-readiness", id] as const,
    workspaceOperations: (id: string) => ["execution-workspaces", "workspace-operations", id] as const,
  },
  environments: {
    list: (companyId: string) => ["environments", companyId] as const,
  },
  projects: {
    list: (companyId: string) => ["projects", companyId] as const,
    detail: (id: string) => ["projects", "detail", id] as const,
  },
  goals: {
    list: (companyId: string) => ["goals", companyId] as const,
    detail: (id: string) => ["goals", "detail", id] as const,
  },
  budgets: {
    overview: (companyId: string) => ["budgets", "overview", companyId] as const,
  },
  approvals: {
    list: (companyId: string, status?: string) =>
      ["approvals", companyId, status] as const,
    detail: (approvalId: string) => ["approvals", "detail", approvalId] as const,
    comments: (approvalId: string) => ["approvals", "comments", approvalId] as const,
    tasks: (approvalId: string) => ["approvals", "tasks", approvalId] as const,
  },
  access: {
    invites: (companyId: string, state: string = "all", limit: number = 20) =>
      ["access", "invites", "paginated-v1", companyId, state, limit] as const,
    joinRequests: (companyId: string, status: string = "pending_approval") =>
      ["access", "join-requests", companyId, status] as const,
    companyMembers: (companyId: string) => ["access", "company-members", companyId] as const,
    companyUserDirectory: (companyId: string) => ["access", "company-user-directory", companyId] as const,
    adminUsers: (query: string) => ["access", "admin-users", query] as const,
    userCompanyAccess: (userId: string) => ["access", "user-company-access", userId] as const,
    invite: (token: string) => ["access", "invite", token] as const,
    currentBoardAccess: ["access", "current-board-access"] as const,
  },
  auth: {
    session: ["auth", "session"] as const,
  },
  sidebarPreferences: {
    companyOrder: (userId: string) => ["sidebar-preferences", "company-order", userId] as const,
    projectOrder: (companyId: string, userId: string) =>
      ["sidebar-preferences", "project-order", companyId, userId] as const,
  },
  instance: {
    generalSettings: ["instance", "general-settings"] as const,
    schedulerHeartbeats: ["instance", "scheduler-heartbeats"] as const,
    experimentalSettings: ["instance", "experimental-settings"] as const,
  },
  health: ["health"] as const,
  secrets: {
    list: (companyId: string) => ["secrets", companyId] as const,
    providers: (companyId: string) => ["secret-providers", companyId] as const,
  },
  externalApps: {
    list: (companyId: string) => ["external-apps", companyId] as const,
  },
  dashboard: (companyId: string) => ["dashboard", companyId] as const,
  userProfile: (companyId: string, userSlug: string) =>
    ["user-profile", companyId, userSlug] as const,
  sidebarBadges: (companyId: string) => ["sidebar-badges", companyId] as const,
  inboxDismissals: (companyId: string) => ["inbox-dismissals", companyId] as const,
  activity: (companyId: string) => ["activity", companyId] as const,
  costs: (companyId: string, from?: string, to?: string) =>
    ["costs", companyId, from, to] as const,
  usageByProvider: (companyId: string, from?: string, to?: string) =>
    ["usage-by-provider", companyId, from, to] as const,
  usageByBiller: (companyId: string, from?: string, to?: string) =>
    ["usage-by-biller", companyId, from, to] as const,
  financeSummary: (companyId: string, from?: string, to?: string) =>
    ["finance-summary", companyId, from, to] as const,
  financeByBiller: (companyId: string, from?: string, to?: string) =>
    ["finance-by-biller", companyId, from, to] as const,
  financeByKind: (companyId: string, from?: string, to?: string) =>
    ["finance-by-kind", companyId, from, to] as const,
  financeEvents: (companyId: string, from?: string, to?: string, limit: number = 100) =>
    ["finance-events", companyId, from, to, limit] as const,
  usageWindowSpend: (companyId: string) =>
    ["usage-window-spend", companyId] as const,
  usageQuotaWindows: (companyId: string) =>
    ["usage-quota-windows", companyId] as const,
  heartbeats: (companyId: string, agentId?: string) =>
    ["heartbeats", companyId, agentId] as const,
  runDetail: (runId: string) => ["heartbeat-run", runId] as const,
  runWorkspaceOperations: (runId: string) => ["heartbeat-run", runId, "workspace-operations"] as const,
  liveRuns: (companyId: string) => ["live-runs", companyId] as const,
  runTasks: (runId: string) => ["run-tasks", runId] as const,
  org: (companyId: string) => ["org", companyId] as const,
  skills: {
    available: ["skills", "available"] as const,
  },
  plugins: {
    all: ["plugins"] as const,
    examples: ["plugins", "examples"] as const,
    detail: (pluginId: string) => ["plugins", pluginId] as const,
    health: (pluginId: string) => ["plugins", pluginId, "health"] as const,
    uiContributions: ["plugins", "ui-contributions"] as const,
    config: (pluginId: string) => ["plugins", pluginId, "config"] as const,
    dashboard: (pluginId: string) => ["plugins", pluginId, "dashboard"] as const,
    logs: (pluginId: string) => ["plugins", pluginId, "logs"] as const,
  },
  adapters: {
    all: ["adapters"] as const,
  },
};
