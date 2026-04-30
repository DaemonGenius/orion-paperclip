import { randomUUID } from "node:crypto";
import type {
  PaperclipPluginManifestV1,
  PluginCapability,
  PluginEventType,
  PluginTaskOriginKind,
  Company,
  Project,
  Task,
  TaskComment,
  TaskThreadInteraction,
  CreateTaskThreadInteraction,
  TaskDocument,
  Agent,
  Goal,
} from "@paperclipai/shared";
import type {
  EventFilter,
  PluginContext,
  PluginEntityRecord,
  PluginEntityUpsert,
  PluginJobContext,
  PluginLauncherRegistration,
  PluginEvent,
  ScopeKey,
  ToolResult,
  ToolRunContext,
  PluginWorkspace,
  AgentSession,
  AgentSessionEvent,
} from "./types.js";
import type {
  PluginEnvironmentValidateConfigParams,
  PluginEnvironmentValidationResult,
  PluginEnvironmentProbeParams,
  PluginEnvironmentProbeResult,
  PluginEnvironmentLease,
  PluginEnvironmentAcquireLeaseParams,
  PluginEnvironmentResumeLeaseParams,
  PluginEnvironmentReleaseLeaseParams,
  PluginEnvironmentDestroyLeaseParams,
  PluginEnvironmentRealizeWorkspaceParams,
  PluginEnvironmentRealizeWorkspaceResult,
  PluginEnvironmentExecuteParams,
  PluginEnvironmentExecuteResult,
} from "./protocol.js";

export interface TestHarnessOptions {
  /** Plugin manifest used to seed capability checks and metadata. */
  manifest: PaperclipPluginManifestV1;
  /** Optional capability override. Defaults to `manifest.capabilities`. */
  capabilities?: PluginCapability[];
  /** Initial config returned by `ctx.config.get()`. */
  config?: Record<string, unknown>;
}

export interface TestHarnessLogEntry {
  level: "info" | "warn" | "error" | "debug";
  message: string;
  meta?: Record<string, unknown>;
}

export interface TestHarness {
  /** Fully-typed in-memory plugin context passed to `plugin.setup(ctx)`. */
  ctx: PluginContext;
  /** Seed host entities for `ctx.companies/projects/tasks/agents/goals` reads. */
  seed(input: {
    companies?: Company[];
    projects?: Project[];
    tasks?: Task[];
    taskComments?: TaskComment[];
    agents?: Agent[];
    goals?: Goal[];
  }): void;
  setConfig(config: Record<string, unknown>): void;
  /** Dispatch a host or plugin event to registered handlers. */
  emit(eventType: PluginEventType | `plugin.${string}`, payload: unknown, base?: Partial<PluginEvent>): Promise<void>;
  /** Execute a previously-registered scheduled job handler. */
  runJob(jobKey: string, partial?: Partial<PluginJobContext>): Promise<void>;
  /** Invoke a `ctx.data.register(...)` handler by key. */
  getData<T = unknown>(key: string, params?: Record<string, unknown>): Promise<T>;
  /** Invoke a `ctx.actions.register(...)` handler by key. */
  performAction<T = unknown>(key: string, params?: Record<string, unknown>): Promise<T>;
  /** Execute a registered tool handler via `ctx.tools.execute(...)`. */
  executeTool<T = ToolResult>(name: string, params: unknown, runCtx?: Partial<ToolRunContext>): Promise<T>;
  /** Read raw in-memory state for assertions. */
  getState(input: ScopeKey): unknown;
  /** Simulate a streaming event arriving for an active session. */
  simulateSessionEvent(sessionId: string, event: Omit<AgentSessionEvent, "sessionId">): void;
  logs: TestHarnessLogEntry[];
  activity: Array<{ message: string; entityType?: string; entityId?: string; metadata?: Record<string, unknown> }>;
  metrics: Array<{ name: string; value: number; tags?: Record<string, string> }>;
  telemetry: Array<{ eventName: string; dimensions?: Record<string, string | number | boolean> }>;
  dbQueries: Array<{ sql: string; params?: unknown[] }>;
  dbExecutes: Array<{ sql: string; params?: unknown[] }>;
}

// ---------------------------------------------------------------------------
// Environment test harness types
// ---------------------------------------------------------------------------

/** Recorded environment lifecycle event for assertion helpers. */
export interface EnvironmentEventRecord {
  type:
    | "validateConfig"
    | "probe"
    | "acquireLease"
    | "resumeLease"
    | "releaseLease"
    | "destroyLease"
    | "realizeWorkspace"
    | "execute";
  driverKey: string;
  environmentId: string;
  timestamp: string;
  params: Record<string, unknown>;
  result?: unknown;
  error?: string;
}

/** Options for creating an environment-aware test harness. */
export interface EnvironmentTestHarnessOptions extends TestHarnessOptions {
  /** Environment driver hooks provided by the plugin under test. */
  environmentDriver: {
    driverKey: string;
    onValidateConfig?: (params: PluginEnvironmentValidateConfigParams) => Promise<PluginEnvironmentValidationResult>;
    onProbe?: (params: PluginEnvironmentProbeParams) => Promise<PluginEnvironmentProbeResult>;
    onAcquireLease?: (params: PluginEnvironmentAcquireLeaseParams) => Promise<PluginEnvironmentLease>;
    onResumeLease?: (params: PluginEnvironmentResumeLeaseParams) => Promise<PluginEnvironmentLease>;
    onReleaseLease?: (params: PluginEnvironmentReleaseLeaseParams) => Promise<void>;
    onDestroyLease?: (params: PluginEnvironmentDestroyLeaseParams) => Promise<void>;
    onRealizeWorkspace?: (params: PluginEnvironmentRealizeWorkspaceParams) => Promise<PluginEnvironmentRealizeWorkspaceResult>;
    onExecute?: (params: PluginEnvironmentExecuteParams) => Promise<PluginEnvironmentExecuteResult>;
  };
}

/** Extended test harness with environment driver simulation. */
export interface EnvironmentTestHarness extends TestHarness {
  /** Recorded environment lifecycle events for assertion. */
  environmentEvents: EnvironmentEventRecord[];
  /** Invoke the environment driver's validateConfig hook. */
  validateConfig(params: PluginEnvironmentValidateConfigParams): Promise<PluginEnvironmentValidationResult>;
  /** Invoke the environment driver's probe hook. */
  probe(params: PluginEnvironmentProbeParams): Promise<PluginEnvironmentProbeResult>;
  /** Invoke the environment driver's acquireLease hook. */
  acquireLease(params: PluginEnvironmentAcquireLeaseParams): Promise<PluginEnvironmentLease>;
  /** Invoke the environment driver's resumeLease hook. */
  resumeLease(params: PluginEnvironmentResumeLeaseParams): Promise<PluginEnvironmentLease>;
  /** Invoke the environment driver's releaseLease hook. */
  releaseLease(params: PluginEnvironmentReleaseLeaseParams): Promise<void>;
  /** Invoke the environment driver's destroyLease hook. */
  destroyLease(params: PluginEnvironmentDestroyLeaseParams): Promise<void>;
  /** Invoke the environment driver's realizeWorkspace hook. */
  realizeWorkspace(params: PluginEnvironmentRealizeWorkspaceParams): Promise<PluginEnvironmentRealizeWorkspaceResult>;
  /** Invoke the environment driver's execute hook. */
  execute(params: PluginEnvironmentExecuteParams): Promise<PluginEnvironmentExecuteResult>;
}

// ---------------------------------------------------------------------------
// Environment event assertion helpers
// ---------------------------------------------------------------------------

/** Filter environment events by type. */
export function filterEnvironmentEvents(
  events: EnvironmentEventRecord[],
  type: EnvironmentEventRecord["type"],
): EnvironmentEventRecord[] {
  return events.filter((e) => e.type === type);
}

/** Assert that environment events occurred in the expected order. */
export function assertEnvironmentEventOrder(
  events: EnvironmentEventRecord[],
  expectedOrder: EnvironmentEventRecord["type"][],
): void {
  const actual = events.map((e) => e.type);
  const matched: EnvironmentEventRecord["type"][] = [];
  let cursor = 0;
  for (const eventType of actual) {
    if (cursor < expectedOrder.length && eventType === expectedOrder[cursor]) {
      matched.push(eventType);
      cursor++;
    }
  }
  if (matched.length !== expectedOrder.length) {
    throw new Error(
      `Environment event order mismatch.\nExpected: ${JSON.stringify(expectedOrder)}\nActual:   ${JSON.stringify(actual)}`,
    );
  }
}

/** Assert that a full lease lifecycle (acquire → release) occurred for an environment. */
export function assertLeaseLifecycle(
  events: EnvironmentEventRecord[],
  environmentId: string,
): { acquire: EnvironmentEventRecord; release: EnvironmentEventRecord } {
  const acquire = events.find((e) => e.type === "acquireLease" && e.environmentId === environmentId);
  const release = events.find((e) => (e.type === "releaseLease" || e.type === "destroyLease") && e.environmentId === environmentId);
  if (!acquire) throw new Error(`No acquireLease event found for environment ${environmentId}`);
  if (!release) throw new Error(`No releaseLease/destroyLease event found for environment ${environmentId}`);
  if (acquire.timestamp > release.timestamp) {
    throw new Error(`acquireLease occurred after release for environment ${environmentId}`);
  }
  return { acquire, release };
}

/** Assert that workspace realization occurred between lease acquire and release. */
export function assertWorkspaceRealizationLifecycle(
  events: EnvironmentEventRecord[],
  environmentId: string,
): EnvironmentEventRecord {
  const lifecycle = assertLeaseLifecycle(events, environmentId);
  const realize = events.find(
    (e) => e.type === "realizeWorkspace" && e.environmentId === environmentId,
  );
  if (!realize) throw new Error(`No realizeWorkspace event found for environment ${environmentId}`);
  if (realize.timestamp < lifecycle.acquire.timestamp) {
    throw new Error(`realizeWorkspace occurred before acquireLease for environment ${environmentId}`);
  }
  if (realize.timestamp > lifecycle.release.timestamp) {
    throw new Error(`realizeWorkspace occurred after release for environment ${environmentId}`);
  }
  return realize;
}

/** Assert that an execute call occurred within the lease lifecycle. */
export function assertExecutionLifecycle(
  events: EnvironmentEventRecord[],
  environmentId: string,
): EnvironmentEventRecord[] {
  const lifecycle = assertLeaseLifecycle(events, environmentId);
  const execEvents = events.filter(
    (e) => e.type === "execute" && e.environmentId === environmentId,
  );
  if (execEvents.length === 0) {
    throw new Error(`No execute events found for environment ${environmentId}`);
  }
  for (const exec of execEvents) {
    if (exec.timestamp < lifecycle.acquire.timestamp || exec.timestamp > lifecycle.release.timestamp) {
      throw new Error(`Execute event occurred outside lease lifecycle for environment ${environmentId}`);
    }
  }
  return execEvents;
}

/** Assert that an event recorded an error. */
export function assertEnvironmentError(
  events: EnvironmentEventRecord[],
  type: EnvironmentEventRecord["type"],
  environmentId?: string,
): EnvironmentEventRecord {
  const match = events.find(
    (e) => e.type === type && e.error != null && (!environmentId || e.environmentId === environmentId),
  );
  if (!match) {
    throw new Error(`No error event of type '${type}'${environmentId ? ` for environment ${environmentId}` : ""}`);
  }
  return match;
}

// ---------------------------------------------------------------------------
// Fake environment plugin driver
// ---------------------------------------------------------------------------

/** Options for creating a fake environment driver for contract testing. */
export interface FakeEnvironmentDriverOptions {
  driverKey?: string;
  /** Simulated acquire delay in ms. */
  acquireDelayMs?: number;
  /** If true, probe will return `ok: false`. */
  probeFailure?: boolean;
  /** If true, acquireLease will throw. */
  acquireFailure?: string;
  /** If true, execute will return a non-zero exit code. */
  executeFailure?: boolean;
  /** Custom metadata returned on lease acquire. */
  leaseMetadata?: Record<string, unknown>;
}

/**
 * Create a fake environment driver suitable for contract testing.
 *
 * This returns a driver hooks object compatible with `EnvironmentTestHarnessOptions.environmentDriver`.
 * It simulates the full environment lifecycle with configurable failure injection.
 */
export function createFakeEnvironmentDriver(options: FakeEnvironmentDriverOptions = {}): EnvironmentTestHarnessOptions["environmentDriver"] {
  const driverKey = options.driverKey ?? "fake";
  const leases = new Map<string, { providerLeaseId: string; metadata: Record<string, unknown> }>();
  let leaseCounter = 0;

  return {
    driverKey,
    async onValidateConfig(params) {
      if (!params.config || typeof params.config !== "object") {
        return { ok: false, errors: ["Config must be an object"] };
      }
      return { ok: true, normalizedConfig: params.config };
    },
    async onProbe(_params) {
      if (options.probeFailure) {
        return { ok: false, summary: "Simulated probe failure", diagnostics: [{ severity: "error", message: "Probe failed" }] };
      }
      return { ok: true, summary: "Fake environment is healthy" };
    },
    async onAcquireLease(params) {
      if (options.acquireFailure) {
        throw new Error(options.acquireFailure);
      }
      if (options.acquireDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.acquireDelayMs));
      }
      const providerLeaseId = `fake-lease-${++leaseCounter}`;
      const metadata = { ...options.leaseMetadata, acquiredAt: new Date().toISOString(), runId: params.runId };
      leases.set(providerLeaseId, { providerLeaseId, metadata });
      return { providerLeaseId, metadata };
    },
    async onResumeLease(params) {
      const existing = leases.get(params.providerLeaseId);
      if (!existing) {
        throw new Error(`Lease ${params.providerLeaseId} not found — cannot resume`);
      }
      return { providerLeaseId: existing.providerLeaseId, metadata: { ...existing.metadata, resumed: true } };
    },
    async onReleaseLease(params) {
      if (params.providerLeaseId) {
        leases.delete(params.providerLeaseId);
      }
    },
    async onDestroyLease(params) {
      if (params.providerLeaseId) {
        leases.delete(params.providerLeaseId);
      }
    },
    async onRealizeWorkspace(params) {
      return {
        cwd: params.workspace.localPath ?? params.workspace.remotePath ?? "/tmp/fake-workspace",
        metadata: { realized: true },
      };
    },
    async onExecute(params) {
      if (options.executeFailure) {
        return { exitCode: 1, timedOut: false, stdout: "", stderr: "Simulated execution failure" };
      }
      return {
        exitCode: 0,
        timedOut: false,
        stdout: `Executed: ${params.command} ${(params.args ?? []).join(" ")}`.trim(),
        stderr: "",
      };
    },
  };
}

type EventRegistration = {
  name: PluginEventType | `plugin.${string}`;
  filter?: EventFilter;
  fn: (event: PluginEvent) => Promise<void>;
};

function normalizeScope(input: ScopeKey): Required<Pick<ScopeKey, "scopeKind" | "stateKey">> & Pick<ScopeKey, "scopeId" | "namespace"> {
  return {
    scopeKind: input.scopeKind,
    scopeId: input.scopeId,
    namespace: input.namespace ?? "default",
    stateKey: input.stateKey,
  };
}

function stateMapKey(input: ScopeKey): string {
  const normalized = normalizeScope(input);
  return `${normalized.scopeKind}|${normalized.scopeId ?? ""}|${normalized.namespace}|${normalized.stateKey}`;
}

function allowsEvent(filter: EventFilter | undefined, event: PluginEvent): boolean {
  if (!filter) return true;
  if (filter.companyId && filter.companyId !== String((event.payload as Record<string, unknown> | undefined)?.companyId ?? "")) return false;
  if (filter.projectId && filter.projectId !== String((event.payload as Record<string, unknown> | undefined)?.projectId ?? "")) return false;
  if (filter.agentId && filter.agentId !== String((event.payload as Record<string, unknown> | undefined)?.agentId ?? "")) return false;
  return true;
}

function requireCapability(manifest: PaperclipPluginManifestV1, allowed: Set<PluginCapability>, capability: PluginCapability) {
  if (allowed.has(capability)) return;
  throw new Error(`Plugin '${manifest.id}' is missing required capability '${capability}' in test harness`);
}

function requireCompanyId(companyId?: string): string {
  if (!companyId) throw new Error("companyId is required for this operation");
  return companyId;
}

function isInCompany<T extends { companyId: string | null | undefined }>(
  record: T | null | undefined,
  companyId: string,
): record is T {
  return Boolean(record && record.companyId === companyId);
}

/**
 * Create an in-memory host harness for plugin worker tests.
 *
 * The harness enforces declared capabilities and simulates host APIs, so tests
 * can validate plugin behavior without spinning up the Paperclip server runtime.
 */
export function createTestHarness(options: TestHarnessOptions): TestHarness {
  const manifest = options.manifest;
  const capabilitySet = new Set(options.capabilities ?? manifest.capabilities);
  let currentConfig = { ...(options.config ?? {}) };

  const logs: TestHarnessLogEntry[] = [];
  const activity: TestHarness["activity"] = [];
  const metrics: TestHarness["metrics"] = [];
  const telemetry: TestHarness["telemetry"] = [];
  const dbQueries: TestHarness["dbQueries"] = [];
  const dbExecutes: TestHarness["dbExecutes"] = [];

  const state = new Map<string, unknown>();
  const entities = new Map<string, PluginEntityRecord>();
  const entityExternalIndex = new Map<string, string>();
  const companies = new Map<string, Company>();
  const projects = new Map<string, Project>();
  const tasks = new Map<string, Task>();
  const blockedByTaskIds = new Map<string, string[]>();
  const taskComments = new Map<string, TaskComment[]>();
  const taskInteractions = new Map<string, TaskThreadInteraction[]>();
  const taskDocuments = new Map<string, TaskDocument>();
  const agents = new Map<string, Agent>();
  const goals = new Map<string, Goal>();
  const projectWorkspaces = new Map<string, PluginWorkspace[]>();

  const sessions = new Map<string, AgentSession>();
  const sessionEventCallbacks = new Map<string, (event: AgentSessionEvent) => void>();

  const events: EventRegistration[] = [];
  const jobs = new Map<string, (job: PluginJobContext) => Promise<void>>();
  const launchers = new Map<string, PluginLauncherRegistration>();
  const dataHandlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
  const actionHandlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
  const toolHandlers = new Map<string, (params: unknown, runCtx: ToolRunContext) => Promise<ToolResult>>();

  function taskRelationSummary(taskId: string) {
    const task = tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const summarize = (candidateId: string) => {
      const related = tasks.get(candidateId);
      if (!related || related.companyId !== task.companyId) return null;
      return {
        id: related.id,
        identifier: related.identifier,
        title: related.title,
        status: related.status,
        priority: related.priority,
        assigneeAgentId: related.assigneeAgentId,
        assigneeUserId: related.assigneeUserId,
      };
    };
    const blockedBy = (blockedByTaskIds.get(taskId) ?? [])
      .map(summarize)
      .filter((value): value is NonNullable<typeof value> => value !== null);
    const blocks = [...blockedByTaskIds.entries()]
      .filter(([, blockers]) => blockers.includes(taskId))
      .map(([blockedTaskId]) => summarize(blockedTaskId))
      .filter((value): value is NonNullable<typeof value> => value !== null);
    return { blockedBy, blocks };
  }

  const defaultPluginOriginKind: PluginTaskOriginKind = `plugin:${manifest.id}`;
  function normalizePluginOriginKind(originKind: unknown = defaultPluginOriginKind): PluginTaskOriginKind {
    if (originKind == null || originKind === "") return defaultPluginOriginKind;
    if (typeof originKind !== "string") throw new Error("Plugin task originKind must be a string");
    if (originKind === defaultPluginOriginKind || originKind.startsWith(`${defaultPluginOriginKind}:`)) {
      return originKind as PluginTaskOriginKind;
    }
    throw new Error(`Plugin may only use originKind values under ${defaultPluginOriginKind}`);
  }

  const ctx: PluginContext = {
    manifest,
    config: {
      async get() {
        return { ...currentConfig };
      },
    },
    events: {
      on(name: PluginEventType | `plugin.${string}`, filterOrFn: EventFilter | ((event: PluginEvent) => Promise<void>), maybeFn?: (event: PluginEvent) => Promise<void>): () => void {
        requireCapability(manifest, capabilitySet, "events.subscribe");
        let registration: EventRegistration;
        if (typeof filterOrFn === "function") {
          registration = { name, fn: filterOrFn };
        } else {
          if (!maybeFn) throw new Error("event handler is required");
          registration = { name, filter: filterOrFn, fn: maybeFn };
        }
        events.push(registration);
        return () => {
          const idx = events.indexOf(registration);
          if (idx !== -1) events.splice(idx, 1);
        };
      },
      async emit(name, companyId, payload) {
        requireCapability(manifest, capabilitySet, "events.emit");
        await harness.emit(`plugin.${manifest.id}.${name}`, payload, { companyId });
      },
    },
    jobs: {
      register(key, fn) {
        requireCapability(manifest, capabilitySet, "jobs.schedule");
        jobs.set(key, fn);
      },
    },
    launchers: {
      register(launcher) {
        launchers.set(launcher.id, launcher);
      },
    },
    db: {
      namespace: manifest.database ? `test_${manifest.id.replace(/[^a-z0-9_]+/g, "_")}` : "",
      async query(sql, params) {
        requireCapability(manifest, capabilitySet, "database.namespace.read");
        dbQueries.push({ sql, params });
        return [];
      },
      async execute(sql, params) {
        requireCapability(manifest, capabilitySet, "database.namespace.write");
        dbExecutes.push({ sql, params });
        return { rowCount: 0 };
      },
    },
    http: {
      async fetch(url, init) {
        requireCapability(manifest, capabilitySet, "http.outbound");
        return fetch(url, init);
      },
    },
    secrets: {
      async resolve(secretRef) {
        requireCapability(manifest, capabilitySet, "secrets.read-ref");
        return `resolved:${secretRef}`;
      },
    },
    activity: {
      async log(entry) {
        requireCapability(manifest, capabilitySet, "activity.log.write");
        activity.push(entry);
      },
    },
    state: {
      async get(input) {
        requireCapability(manifest, capabilitySet, "plugin.state.read");
        return state.has(stateMapKey(input)) ? state.get(stateMapKey(input)) : null;
      },
      async set(input, value) {
        requireCapability(manifest, capabilitySet, "plugin.state.write");
        state.set(stateMapKey(input), value);
      },
      async delete(input) {
        requireCapability(manifest, capabilitySet, "plugin.state.write");
        state.delete(stateMapKey(input));
      },
    },
    entities: {
      async upsert(input: PluginEntityUpsert) {
        const externalKey = input.externalId
          ? `${input.entityType}|${input.scopeKind}|${input.scopeId ?? ""}|${input.externalId}`
          : null;
        const existingId = externalKey ? entityExternalIndex.get(externalKey) : undefined;
        const existing = existingId ? entities.get(existingId) : undefined;
        const now = new Date().toISOString();
        const previousExternalKey = existing?.externalId
          ? `${existing.entityType}|${existing.scopeKind}|${existing.scopeId ?? ""}|${existing.externalId}`
          : null;
        const record: PluginEntityRecord = existing
          ? {
            ...existing,
            entityType: input.entityType,
            scopeKind: input.scopeKind,
            scopeId: input.scopeId ?? null,
            externalId: input.externalId ?? null,
            title: input.title ?? null,
            status: input.status ?? null,
            data: input.data,
            updatedAt: now,
          }
          : {
            id: randomUUID(),
            entityType: input.entityType,
            scopeKind: input.scopeKind,
            scopeId: input.scopeId ?? null,
            externalId: input.externalId ?? null,
            title: input.title ?? null,
            status: input.status ?? null,
            data: input.data,
            createdAt: now,
            updatedAt: now,
          };
        entities.set(record.id, record);
        if (previousExternalKey && previousExternalKey !== externalKey) {
          entityExternalIndex.delete(previousExternalKey);
        }
        if (externalKey) entityExternalIndex.set(externalKey, record.id);
        return record;
      },
      async list(query) {
        let out = [...entities.values()];
        if (query.entityType) out = out.filter((r) => r.entityType === query.entityType);
        if (query.scopeKind) out = out.filter((r) => r.scopeKind === query.scopeKind);
        if (query.scopeId) out = out.filter((r) => r.scopeId === query.scopeId);
        if (query.externalId) out = out.filter((r) => r.externalId === query.externalId);
        if (query.offset) out = out.slice(query.offset);
        if (query.limit) out = out.slice(0, query.limit);
        return out;
      },
    },
    projects: {
      async list(input) {
        requireCapability(manifest, capabilitySet, "projects.read");
        const companyId = requireCompanyId(input?.companyId);
        let out = [...projects.values()];
        out = out.filter((project) => project.companyId === companyId);
        if (input?.offset) out = out.slice(input.offset);
        if (input?.limit) out = out.slice(0, input.limit);
        return out;
      },
      async get(projectId, companyId) {
        requireCapability(manifest, capabilitySet, "projects.read");
        const project = projects.get(projectId);
        return isInCompany(project, companyId) ? project : null;
      },
      async listWorkspaces(projectId, companyId) {
        requireCapability(manifest, capabilitySet, "project.workspaces.read");
        if (!isInCompany(projects.get(projectId), companyId)) return [];
        return projectWorkspaces.get(projectId) ?? [];
      },
      async getPrimaryWorkspace(projectId, companyId) {
        requireCapability(manifest, capabilitySet, "project.workspaces.read");
        if (!isInCompany(projects.get(projectId), companyId)) return null;
        const workspaces = projectWorkspaces.get(projectId) ?? [];
        return workspaces.find((workspace) => workspace.isPrimary) ?? null;
      },
      async getWorkspaceForTask(taskId, companyId) {
        requireCapability(manifest, capabilitySet, "project.workspaces.read");
        const task = tasks.get(taskId);
        if (!isInCompany(task, companyId)) return null;
        const projectId = (task as unknown as Record<string, unknown>)?.projectId as string | undefined;
        if (!projectId) return null;
        if (!isInCompany(projects.get(projectId), companyId)) return null;
        const workspaces = projectWorkspaces.get(projectId) ?? [];
        return workspaces.find((workspace) => workspace.isPrimary) ?? null;
      },
    },
    companies: {
      async list(input) {
        requireCapability(manifest, capabilitySet, "companies.read");
        let out = [...companies.values()];
        if (input?.offset) out = out.slice(input.offset);
        if (input?.limit) out = out.slice(0, input.limit);
        return out;
      },
      async get(companyId) {
        requireCapability(manifest, capabilitySet, "companies.read");
        return companies.get(companyId) ?? null;
      },
    },
    tasks: {
      async list(input) {
        requireCapability(manifest, capabilitySet, "tasks.read");
        const companyId = requireCompanyId(input?.companyId);
        let out = [...tasks.values()];
        out = out.filter((task) => task.companyId === companyId);
        if (input?.projectId) out = out.filter((task) => task.projectId === input.projectId);
        if (input?.assigneeAgentId) out = out.filter((task) => task.assigneeAgentId === input.assigneeAgentId);
        if (input?.originKind) {
          if (input.originKind.startsWith("plugin:")) normalizePluginOriginKind(input.originKind);
          out = out.filter((task) => task.originKind === input.originKind);
        }
        if (input?.originId) out = out.filter((task) => task.originId === input.originId);
        if (input?.status) out = out.filter((task) => task.status === input.status);
        if (input?.offset) out = out.slice(input.offset);
        if (input?.limit) out = out.slice(0, input.limit);
        return out;
      },
      async get(taskId, companyId) {
        requireCapability(manifest, capabilitySet, "tasks.read");
        const task = tasks.get(taskId);
        return isInCompany(task, companyId) ? task : null;
      },
      async create(input) {
        requireCapability(manifest, capabilitySet, "tasks.create");
        const now = new Date();
        const record: Task = {
          id: randomUUID(),
          companyId: input.companyId,
          projectId: input.projectId ?? null,
          projectWorkspaceId: null,
          goalId: input.goalId ?? null,
          parentId: input.parentId ?? null,
          title: input.title,
          description: input.description ?? null,
          status: input.status ?? "todo",
          priority: input.priority ?? "medium",
          assigneeAgentId: input.assigneeAgentId ?? null,
          assigneeUserId: input.assigneeUserId ?? null,
          checkoutRunId: null,
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          createdByAgentId: null,
          createdByUserId: null,
          taskNumber: null,
          identifier: null,
          originKind: normalizePluginOriginKind(input.originKind),
          originId: input.originId ?? null,
          originRunId: input.originRunId ?? null,
          requestDepth: input.requestDepth ?? 0,
          billingCode: input.billingCode ?? null,
          assigneeAdapterOverrides: null,
          executionWorkspaceId: input.executionWorkspaceId ?? null,
          executionWorkspacePreference: input.executionWorkspacePreference ?? null,
          executionWorkspaceSettings: input.executionWorkspaceSettings ?? null,
          startedAt: null,
          completedAt: null,
          cancelledAt: null,
          hiddenAt: null,
          createdAt: now,
          updatedAt: now,
        };
        tasks.set(record.id, record);
        if (input.blockedByTaskIds) blockedByTaskIds.set(record.id, [...new Set(input.blockedByTaskIds)]);
        return record;
      },
      async update(taskId, patch, companyId) {
        requireCapability(manifest, capabilitySet, "tasks.update");
        const record = tasks.get(taskId);
        if (!isInCompany(record, companyId)) throw new Error(`Task not found: ${taskId}`);
        const { blockedByTaskIds: nextBlockedByTaskIds, ...taskPatch } = patch;
        if (taskPatch.originKind !== undefined) {
          taskPatch.originKind = normalizePluginOriginKind(taskPatch.originKind);
        }
        const updated: Task = {
          ...record,
          ...taskPatch,
          updatedAt: new Date(),
        };
        tasks.set(taskId, updated);
        if (nextBlockedByTaskIds !== undefined) {
          blockedByTaskIds.set(taskId, [...new Set(nextBlockedByTaskIds)]);
        }
        return updated;
      },
      async assertCheckoutOwner(input) {
        requireCapability(manifest, capabilitySet, "tasks.checkout");
        const record = tasks.get(input.taskId);
        if (!isInCompany(record, input.companyId)) throw new Error(`Task not found: ${input.taskId}`);
        if (
          record.status !== "in_progress" ||
          record.assigneeAgentId !== input.actorAgentId ||
          (record.checkoutRunId !== null && record.checkoutRunId !== input.actorRunId)
        ) {
          throw new Error("Task run ownership conflict");
        }
        return {
          taskId: record.id,
          status: record.status,
          assigneeAgentId: record.assigneeAgentId,
          checkoutRunId: record.checkoutRunId,
          adoptedFromRunId: null,
        };
      },
      async requestWakeup(taskId, companyId) {
        requireCapability(manifest, capabilitySet, "tasks.wakeup");
        const record = tasks.get(taskId);
        if (!isInCompany(record, companyId)) throw new Error(`Task not found: ${taskId}`);
        if (!record.assigneeAgentId) throw new Error("Task has no assigned agent to wake");
        if (["backlog", "done", "cancelled"].includes(record.status)) {
          throw new Error(`Task is not wakeable in status: ${record.status}`);
        }
        const unresolved = taskRelationSummary(taskId).blockedBy.filter((blocker) => blocker.status !== "done");
        if (unresolved.length > 0) throw new Error("Task is blocked by unresolved blockers");
        return { queued: true, runId: randomUUID() };
      },
      async requestWakeups(taskIds, companyId) {
        requireCapability(manifest, capabilitySet, "tasks.wakeup");
        const results = [];
        for (const taskId of taskIds) {
          const record = tasks.get(taskId);
          if (!isInCompany(record, companyId)) throw new Error(`Task not found: ${taskId}`);
          if (!record.assigneeAgentId) throw new Error("Task has no assigned agent to wake");
          if (["backlog", "done", "cancelled"].includes(record.status)) {
            throw new Error(`Task is not wakeable in status: ${record.status}`);
          }
          const unresolved = taskRelationSummary(taskId).blockedBy.filter((blocker) => blocker.status !== "done");
          if (unresolved.length > 0) throw new Error("Task is blocked by unresolved blockers");
          results.push({ taskId, queued: true, runId: randomUUID() });
        }
        return results;
      },
      async listComments(taskId, companyId) {
        requireCapability(manifest, capabilitySet, "task.comments.read");
        if (!isInCompany(tasks.get(taskId), companyId)) return [];
        return taskComments.get(taskId) ?? [];
      },
      async createComment(taskId, body, companyId, options) {
        requireCapability(manifest, capabilitySet, "task.comments.create");
        const parentTask = tasks.get(taskId);
        if (!isInCompany(parentTask, companyId)) {
          throw new Error(`Task not found: ${taskId}`);
        }
        const now = new Date();
        const comment: TaskComment = {
          id: randomUUID(),
          companyId: parentTask.companyId,
          taskId,
          authorAgentId: options?.authorAgentId ?? null,
          authorUserId: null,
          body,
          createdAt: now,
          updatedAt: now,
        };
        const current = taskComments.get(taskId) ?? [];
        current.push(comment);
        taskComments.set(taskId, current);
        return comment;
      },
      async createInteraction(taskId, interaction, companyId, options) {
        requireCapability(manifest, capabilitySet, "task.interactions.create");
        const parentTask = tasks.get(taskId);
        if (!isInCompany(parentTask, companyId)) {
          throw new Error(`Task not found: ${taskId}`);
        }
        const now = new Date();
        const current = taskInteractions.get(taskId) ?? [];
        if (interaction.idempotencyKey) {
          const existing = current.find((entry) => entry.idempotencyKey === interaction.idempotencyKey);
          if (existing) return existing;
        }
        const created: TaskThreadInteraction = {
          id: randomUUID(),
          companyId: parentTask.companyId,
          taskId,
          kind: interaction.kind,
          status: "pending",
          continuationPolicy: interaction.continuationPolicy ?? "wake_assignee",
          idempotencyKey: interaction.idempotencyKey ?? null,
          sourceCommentId: interaction.sourceCommentId ?? null,
          sourceRunId: interaction.sourceRunId ?? null,
          title: interaction.title ?? null,
          summary: interaction.summary ?? null,
          createdByAgentId: options?.authorAgentId ?? null,
          createdByUserId: null,
          payload: interaction.payload,
          result: null,
          createdAt: now,
          updatedAt: now,
        } as TaskThreadInteraction;
        current.push(created);
        taskInteractions.set(taskId, current);
        return created;
      },
      async suggestTasks(taskId, interaction, companyId, options) {
        return this.createInteraction(taskId, { ...interaction, kind: "suggest_tasks" }, companyId, options) as Promise<any>;
      },
      async askUserQuestions(taskId, interaction, companyId, options) {
        return this.createInteraction(taskId, { ...interaction, kind: "ask_user_questions" }, companyId, options) as Promise<any>;
      },
      async requestConfirmation(taskId, interaction, companyId, options) {
        return this.createInteraction(taskId, { ...interaction, kind: "request_confirmation" }, companyId, options) as Promise<any>;
      },
      documents: {
        async list(taskId, companyId) {
          requireCapability(manifest, capabilitySet, "task.documents.read");
          if (!isInCompany(tasks.get(taskId), companyId)) return [];
          return [...taskDocuments.values()]
            .filter((document) => document.taskId === taskId && document.companyId === companyId)
            .map(({ body: _body, ...summary }) => summary);
        },
        async get(taskId, key, companyId) {
          requireCapability(manifest, capabilitySet, "task.documents.read");
          if (!isInCompany(tasks.get(taskId), companyId)) return null;
          return taskDocuments.get(`${taskId}|${key}`) ?? null;
        },
        async upsert(input) {
          requireCapability(manifest, capabilitySet, "task.documents.write");
          const parentTask = tasks.get(input.taskId);
          if (!isInCompany(parentTask, input.companyId)) {
            throw new Error(`Task not found: ${input.taskId}`);
          }
          const now = new Date();
          const existing = taskDocuments.get(`${input.taskId}|${input.key}`);
          const document: TaskDocument = {
            id: existing?.id ?? randomUUID(),
            companyId: input.companyId,
            taskId: input.taskId,
            key: input.key,
            title: input.title ?? existing?.title ?? null,
            format: "markdown",
            latestRevisionId: randomUUID(),
            latestRevisionNumber: (existing?.latestRevisionNumber ?? 0) + 1,
            createdByAgentId: existing?.createdByAgentId ?? null,
            createdByUserId: existing?.createdByUserId ?? null,
            updatedByAgentId: null,
            updatedByUserId: null,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
            body: input.body,
          };
          taskDocuments.set(`${input.taskId}|${input.key}`, document);
          return document;
        },
        async delete(taskId, _key, companyId) {
          requireCapability(manifest, capabilitySet, "task.documents.write");
          const parentTask = tasks.get(taskId);
          if (!isInCompany(parentTask, companyId)) {
            throw new Error(`Task not found: ${taskId}`);
          }
          taskDocuments.delete(`${taskId}|${_key}`);
        },
      },
      relations: {
        async get(taskId, companyId) {
          requireCapability(manifest, capabilitySet, "task.relations.read");
          if (!isInCompany(tasks.get(taskId), companyId)) throw new Error(`Task not found: ${taskId}`);
          return taskRelationSummary(taskId);
        },
        async setBlockedBy(taskId, nextBlockedByTaskIds, companyId) {
          requireCapability(manifest, capabilitySet, "task.relations.write");
          if (!isInCompany(tasks.get(taskId), companyId)) throw new Error(`Task not found: ${taskId}`);
          blockedByTaskIds.set(taskId, [...new Set(nextBlockedByTaskIds)]);
          return taskRelationSummary(taskId);
        },
        async addBlockers(taskId, blockerTaskIds, companyId) {
          requireCapability(manifest, capabilitySet, "task.relations.write");
          if (!isInCompany(tasks.get(taskId), companyId)) throw new Error(`Task not found: ${taskId}`);
          const next = new Set(blockedByTaskIds.get(taskId) ?? []);
          for (const blockerTaskId of blockerTaskIds) next.add(blockerTaskId);
          blockedByTaskIds.set(taskId, [...next]);
          return taskRelationSummary(taskId);
        },
        async removeBlockers(taskId, blockerTaskIds, companyId) {
          requireCapability(manifest, capabilitySet, "task.relations.write");
          if (!isInCompany(tasks.get(taskId), companyId)) throw new Error(`Task not found: ${taskId}`);
          const removals = new Set(blockerTaskIds);
          blockedByTaskIds.set(
            taskId,
            (blockedByTaskIds.get(taskId) ?? []).filter((blockerTaskId) => !removals.has(blockerTaskId)),
          );
          return taskRelationSummary(taskId);
        },
      },
      async getSubtree(taskId, companyId, options) {
        requireCapability(manifest, capabilitySet, "task.subtree.read");
        const root = tasks.get(taskId);
        if (!isInCompany(root, companyId)) throw new Error(`Task not found: ${taskId}`);
        const includeRoot = options?.includeRoot !== false;
        const allIds = [root.id];
        let frontier = [root.id];
        while (frontier.length > 0) {
          const children = [...tasks.values()]
            .filter((task) => task.companyId === companyId && frontier.includes(task.parentId ?? ""))
            .map((task) => task.id)
            .filter((id) => !allIds.includes(id));
          allIds.push(...children);
          frontier = children;
        }
        const taskIds = includeRoot ? allIds : allIds.filter((id) => id !== root.id);
        const subtreeTasks = taskIds.map((id) => tasks.get(id)).filter((candidate): candidate is Task => Boolean(candidate));
        return {
          rootTaskId: root.id,
          companyId,
          taskIds,
          tasks: subtreeTasks,
          ...(options?.includeRelations
            ? { relations: Object.fromEntries(taskIds.map((id) => [id, taskRelationSummary(id)])) }
            : {}),
          ...(options?.includeDocuments ? { documents: Object.fromEntries(taskIds.map((id) => [id, []])) } : {}),
          ...(options?.includeActiveRuns ? { activeRuns: Object.fromEntries(taskIds.map((id) => [id, []])) } : {}),
          ...(options?.includeAssignees ? { assignees: {} } : {}),
        };
      },
      summaries: {
        async getOrchestration(input) {
          requireCapability(manifest, capabilitySet, "tasks.orchestration.read");
          const root = tasks.get(input.taskId);
          if (!isInCompany(root, input.companyId)) throw new Error(`Task not found: ${input.taskId}`);
          const subtreeTaskIds = [root.id];
          if (input.includeSubtree) {
            let frontier = [root.id];
            while (frontier.length > 0) {
              const children = [...tasks.values()]
                .filter((task) => task.companyId === input.companyId && frontier.includes(task.parentId ?? ""))
                .map((task) => task.id)
                .filter((id) => !subtreeTaskIds.includes(id));
              subtreeTaskIds.push(...children);
              frontier = children;
            }
          }
          return {
            taskId: root.id,
            companyId: input.companyId,
            subtreeTaskIds,
            relations: Object.fromEntries(subtreeTaskIds.map((id) => [id, taskRelationSummary(id)])),
            approvals: [],
            runs: [],
            costs: {
              costCents: 0,
              inputTokens: 0,
              cachedInputTokens: 0,
              outputTokens: 0,
              billingCode: input.billingCode ?? null,
            },
            openBudgetIncidents: [],
            invocationBlocks: [],
          };
        },
      },
    },
    agents: {
      async list(input) {
        requireCapability(manifest, capabilitySet, "agents.read");
        const companyId = requireCompanyId(input?.companyId);
        let out = [...agents.values()];
        out = out.filter((agent) => agent.companyId === companyId);
        if (input?.status) out = out.filter((agent) => agent.status === input.status);
        if (input?.offset) out = out.slice(input.offset);
        if (input?.limit) out = out.slice(0, input.limit);
        return out;
      },
      async get(agentId, companyId) {
        requireCapability(manifest, capabilitySet, "agents.read");
        const agent = agents.get(agentId);
        return isInCompany(agent, companyId) ? agent : null;
      },
      async pause(agentId, companyId) {
        requireCapability(manifest, capabilitySet, "agents.pause");
        const cid = requireCompanyId(companyId);
        const agent = agents.get(agentId);
        if (!isInCompany(agent, cid)) throw new Error(`Agent not found: ${agentId}`);
        if (agent!.status === "terminated") throw new Error("Cannot pause terminated agent");
        const updated: Agent = { ...agent!, status: "paused", updatedAt: new Date() };
        agents.set(agentId, updated);
        return updated;
      },
      async resume(agentId, companyId) {
        requireCapability(manifest, capabilitySet, "agents.resume");
        const cid = requireCompanyId(companyId);
        const agent = agents.get(agentId);
        if (!isInCompany(agent, cid)) throw new Error(`Agent not found: ${agentId}`);
        if (agent!.status === "terminated") throw new Error("Cannot resume terminated agent");
        if (agent!.status === "pending_approval") throw new Error("Pending approval agents cannot be resumed");
        const updated: Agent = { ...agent!, status: "idle", updatedAt: new Date() };
        agents.set(agentId, updated);
        return updated;
      },
      async invoke(agentId, companyId, opts) {
        requireCapability(manifest, capabilitySet, "agents.invoke");
        const cid = requireCompanyId(companyId);
        const agent = agents.get(agentId);
        if (!isInCompany(agent, cid)) throw new Error(`Agent not found: ${agentId}`);
        if (
          agent!.status === "paused" ||
          agent!.status === "terminated" ||
          agent!.status === "pending_approval"
        ) {
          throw new Error(`Agent is not invokable in its current state: ${agent!.status}`);
        }
        return { runId: randomUUID() };
      },
      sessions: {
        async create(agentId, companyId, opts) {
          requireCapability(manifest, capabilitySet, "agent.sessions.create");
          const cid = requireCompanyId(companyId);
          const agent = agents.get(agentId);
          if (!isInCompany(agent, cid)) throw new Error(`Agent not found: ${agentId}`);
          const session: AgentSession = {
            sessionId: randomUUID(),
            agentId,
            companyId: cid,
            status: "active",
            createdAt: new Date().toISOString(),
          };
          sessions.set(session.sessionId, session);
          return session;
        },
        async list(agentId, companyId) {
          requireCapability(manifest, capabilitySet, "agent.sessions.list");
          const cid = requireCompanyId(companyId);
          return [...sessions.values()].filter(
            (s) => s.agentId === agentId && s.companyId === cid && s.status === "active",
          );
        },
        async sendMessage(sessionId, companyId, opts) {
          requireCapability(manifest, capabilitySet, "agent.sessions.send");
          const session = sessions.get(sessionId);
          if (!session || session.status !== "active") throw new Error(`Session not found or closed: ${sessionId}`);
          if (session.companyId !== companyId) throw new Error(`Session not found: ${sessionId}`);
          if (opts.onEvent) {
            sessionEventCallbacks.set(sessionId, opts.onEvent);
          }
          return { runId: randomUUID() };
        },
        async close(sessionId, companyId) {
          requireCapability(manifest, capabilitySet, "agent.sessions.close");
          const session = sessions.get(sessionId);
          if (!session) throw new Error(`Session not found: ${sessionId}`);
          if (session.companyId !== companyId) throw new Error(`Session not found: ${sessionId}`);
          session.status = "closed";
          sessionEventCallbacks.delete(sessionId);
        },
      },
    },
    goals: {
      async list(input) {
        requireCapability(manifest, capabilitySet, "goals.read");
        const companyId = requireCompanyId(input?.companyId);
        let out = [...goals.values()];
        out = out.filter((goal) => goal.companyId === companyId);
        if (input?.level) out = out.filter((goal) => goal.level === input.level);
        if (input?.status) out = out.filter((goal) => goal.status === input.status);
        if (input?.offset) out = out.slice(input.offset);
        if (input?.limit) out = out.slice(0, input.limit);
        return out;
      },
      async get(goalId, companyId) {
        requireCapability(manifest, capabilitySet, "goals.read");
        const goal = goals.get(goalId);
        return isInCompany(goal, companyId) ? goal : null;
      },
      async create(input) {
        requireCapability(manifest, capabilitySet, "goals.create");
        const now = new Date();
        const record: Goal = {
          id: randomUUID(),
          companyId: input.companyId,
          title: input.title,
          description: input.description ?? null,
          level: input.level ?? "task",
          status: input.status ?? "planned",
          parentId: input.parentId ?? null,
          ownerAgentId: input.ownerAgentId ?? null,
          createdAt: now,
          updatedAt: now,
        };
        goals.set(record.id, record);
        return record;
      },
      async update(goalId, patch, companyId) {
        requireCapability(manifest, capabilitySet, "goals.update");
        const record = goals.get(goalId);
        if (!isInCompany(record, companyId)) throw new Error(`Goal not found: ${goalId}`);
        const updated: Goal = {
          ...record,
          ...patch,
          updatedAt: new Date(),
        };
        goals.set(goalId, updated);
        return updated;
      },
    },
    data: {
      register(key, handler) {
        dataHandlers.set(key, handler);
      },
    },
    actions: {
      register(key, handler) {
        actionHandlers.set(key, handler);
      },
    },
    streams: (() => {
      const channelCompanyMap = new Map<string, string>();
      return {
        open(channel: string, companyId: string) {
          channelCompanyMap.set(channel, companyId);
        },
        emit(_channel: string, _event: unknown) {
          // No-op in test harness — events are not forwarded
        },
        close(channel: string) {
          channelCompanyMap.delete(channel);
        },
      };
    })(),
    tools: {
      register(name, _decl, fn) {
        requireCapability(manifest, capabilitySet, "agent.tools.register");
        toolHandlers.set(name, fn);
      },
    },
    metrics: {
      async write(name, value, tags) {
        requireCapability(manifest, capabilitySet, "metrics.write");
        metrics.push({ name, value, tags });
      },
    },
    telemetry: {
      async track(eventName, dimensions) {
        requireCapability(manifest, capabilitySet, "telemetry.track");
        telemetry.push({ eventName, dimensions });
      },
    },
    logger: {
      info(message, meta) {
        logs.push({ level: "info", message, meta });
      },
      warn(message, meta) {
        logs.push({ level: "warn", message, meta });
      },
      error(message, meta) {
        logs.push({ level: "error", message, meta });
      },
      debug(message, meta) {
        logs.push({ level: "debug", message, meta });
      },
    },
  };

  const harness: TestHarness = {
    ctx,
    seed(input) {
      for (const row of input.companies ?? []) companies.set(row.id, row);
      for (const row of input.projects ?? []) projects.set(row.id, row);
      for (const row of input.tasks ?? []) {
        tasks.set(row.id, row);
        if (row.blockedBy) {
          blockedByTaskIds.set(row.id, row.blockedBy.map((blocker) => blocker.id));
        }
      }
      for (const row of input.taskComments ?? []) {
        const list = taskComments.get(row.taskId) ?? [];
        list.push(row);
        taskComments.set(row.taskId, list);
      }
      for (const row of input.agents ?? []) agents.set(row.id, row);
      for (const row of input.goals ?? []) goals.set(row.id, row);
    },
    setConfig(config) {
      currentConfig = { ...config };
    },
    async emit(eventType, payload, base) {
      const event: PluginEvent = {
        eventId: base?.eventId ?? randomUUID(),
        eventType,
        companyId: base?.companyId ?? "test-company",
        occurredAt: base?.occurredAt ?? new Date().toISOString(),
        actorId: base?.actorId,
        actorType: base?.actorType,
        entityId: base?.entityId,
        entityType: base?.entityType,
        payload,
      };

      for (const handler of events) {
        const exactMatch = handler.name === event.eventType;
        const wildcardPluginAll = handler.name === "plugin.*" && String(event.eventType).startsWith("plugin.");
        const wildcardPluginOne = String(handler.name).endsWith(".*")
          && String(event.eventType).startsWith(String(handler.name).slice(0, -1));
        if (!exactMatch && !wildcardPluginAll && !wildcardPluginOne) continue;
        if (!allowsEvent(handler.filter, event)) continue;
        await handler.fn(event);
      }
    },
    async runJob(jobKey, partial = {}) {
      const handler = jobs.get(jobKey);
      if (!handler) throw new Error(`No job handler registered for '${jobKey}'`);
      await handler({
        jobKey,
        runId: partial.runId ?? randomUUID(),
        trigger: partial.trigger ?? "manual",
        scheduledAt: partial.scheduledAt ?? new Date().toISOString(),
      });
    },
    async getData<T = unknown>(key: string, params: Record<string, unknown> = {}) {
      const handler = dataHandlers.get(key);
      if (!handler) throw new Error(`No data handler registered for '${key}'`);
      return await handler(params) as T;
    },
    async performAction<T = unknown>(key: string, params: Record<string, unknown> = {}) {
      const handler = actionHandlers.get(key);
      if (!handler) throw new Error(`No action handler registered for '${key}'`);
      return await handler(params) as T;
    },
    async executeTool<T = ToolResult>(name: string, params: unknown, runCtx: Partial<ToolRunContext> = {}) {
      const handler = toolHandlers.get(name);
      if (!handler) throw new Error(`No tool handler registered for '${name}'`);
      const ctxToPass: ToolRunContext = {
        agentId: runCtx.agentId ?? "agent-test",
        runId: runCtx.runId ?? randomUUID(),
        companyId: runCtx.companyId ?? "company-test",
        projectId: runCtx.projectId ?? "project-test",
      };
      return await handler(params, ctxToPass) as T;
    },
    getState(input) {
      return state.get(stateMapKey(input));
    },
    simulateSessionEvent(sessionId, event) {
      const cb = sessionEventCallbacks.get(sessionId);
      if (!cb) throw new Error(`No active session event callback for session: ${sessionId}`);
      cb({ ...event, sessionId });
    },
    logs,
    activity,
    metrics,
    telemetry,
    dbQueries,
    dbExecutes,
  };

  return harness;
}

/**
 * Create an environment-aware test harness that wraps the base harness with
 * environment driver simulation and lifecycle event recording.
 *
 * Use this to test environment plugins through the full host contract:
 * validateConfig → probe → acquireLease → realizeWorkspace → execute → releaseLease.
 */
export function createEnvironmentTestHarness(options: EnvironmentTestHarnessOptions): EnvironmentTestHarness {
  const base = createTestHarness(options);
  const environmentEvents: EnvironmentEventRecord[] = [];
  const driver = options.environmentDriver;

  function record(
    type: EnvironmentEventRecord["type"],
    params: Record<string, unknown>,
    result?: unknown,
    error?: string,
  ): EnvironmentEventRecord {
    const event: EnvironmentEventRecord = {
      type,
      driverKey: (params as { driverKey?: string }).driverKey ?? driver.driverKey,
      environmentId: (params as { environmentId?: string }).environmentId ?? "unknown",
      timestamp: new Date().toISOString(),
      params,
      result,
      error,
    };
    environmentEvents.push(event);
    return event;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function callHook<R>(
    type: EnvironmentEventRecord["type"],
    hook: ((...args: any[]) => Promise<R>) | undefined,
    params: unknown,
    hookName: string,
  ): Promise<R> {
    if (!hook) {
      const err = `Environment driver '${driver.driverKey}' does not implement ${hookName}`;
      record(type, params as Record<string, unknown>, undefined, err);
      throw new Error(err);
    }
    try {
      const result = await hook(params);
      record(type, params as Record<string, unknown>, result);
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      record(type, params as Record<string, unknown>, undefined, msg);
      throw e;
    }
  }

  const envHarness: EnvironmentTestHarness = {
    ...base,
    environmentEvents,
    async validateConfig(params) {
      return callHook("validateConfig", driver.onValidateConfig, params, "onValidateConfig");
    },
    async probe(params) {
      return callHook("probe", driver.onProbe, params, "onProbe");
    },
    async acquireLease(params) {
      return callHook("acquireLease", driver.onAcquireLease, params, "onAcquireLease");
    },
    async resumeLease(params) {
      return callHook("resumeLease", driver.onResumeLease, params, "onResumeLease");
    },
    async releaseLease(params) {
      return callHook("releaseLease", driver.onReleaseLease, params, "onReleaseLease");
    },
    async destroyLease(params) {
      return callHook("destroyLease", driver.onDestroyLease, params, "onDestroyLease");
    },
    async realizeWorkspace(params) {
      return callHook("realizeWorkspace", driver.onRealizeWorkspace, params, "onRealizeWorkspace");
    },
    async execute(params) {
      return callHook("execute", driver.onExecute, params, "onExecute");
    },
  };

  return envHarness;
}
