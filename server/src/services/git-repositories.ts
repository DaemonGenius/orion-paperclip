import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { and, eq } from "drizzle-orm";
import {
  companyExternalAppBindings,
  projectWorkspaces,
  type Db,
} from "@paperclipai/db";
import {
  bitbucketExternalAppConfigSchema,
  githubExternalAppConfigSchema,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { resolveManagedProjectWorkspaceDir } from "../home-paths.js";
import { secretService } from "./secrets.js";

const execFile = promisify(execFileCallback);
const MANAGED_WORKSPACE_GIT_CLONE_TIMEOUT_MS = 5 * 60 * 1000;
const GIT_OPERATION_TIMEOUT_MS = 90 * 1000;

export type GitRepositoryProvider = "github" | "bitbucket";

export interface GitRepositoryOperationResult {
  provider: GitRepositoryProvider;
  repoUrl: string;
  cwd: string;
  defaultRef: string | null;
  branchTemplate: string | null;
  verifiedAt: string;
  remoteHead: string | null;
  pushCheckOk: boolean;
  pushCheckMessage: string | null;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function sanitizeGitEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (key.startsWith("PAPERCLIP_")) delete env[key];
  }
  delete env.DATABASE_URL;
  return env;
}

function normalizeHost(value: string) {
  return value.trim().replace(/^https?:\/\//i, "").replace(/\/+$/g, "").toLowerCase();
}

function parseRepoUrl(repoUrl: string) {
  let parsed: URL;
  try {
    parsed = new URL(repoUrl);
  } catch {
    throw unprocessable("Repository URL must be a valid HTTPS URL");
  }
  if (parsed.protocol !== "https:") {
    throw unprocessable("Repository URL must use HTTPS");
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 2) {
    throw unprocessable("Repository URL must include an owner/workspace and repository name");
  }
  return {
    url: parsed,
    host: normalizeHost(parsed.hostname),
    repoName: segments[segments.length - 1]?.replace(/\.git$/i, "") || "repo",
  };
}

function deriveRepoNameFromRepoUrl(repoUrl: string | null): string | null {
  const raw = readNonEmptyString(repoUrl);
  if (!raw) return null;
  try {
    return parseRepoUrl(raw).repoName;
  } catch {
    return null;
  }
}

async function writeAskPassScript(input: {
  username: string;
  password: string;
}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-git-auth-"));
  if (process.platform === "win32") {
    const scriptPath = path.join(dir, "askpass.cmd");
    await fs.writeFile(
      scriptPath,
      [
        "@echo off",
        "echo %~1 | findstr /I \"username\" >NUL",
        "if %ERRORLEVEL% EQU 0 (",
        "  echo %GIT_ASKPASS_USERNAME%",
        ") else (",
        "  echo %GIT_ASKPASS_PASSWORD%",
        ")",
        "",
      ].join("\r\n"),
      "utf8",
    );
    return { dir, scriptPath };
  }

  const scriptPath = path.join(dir, "askpass.sh");
  await fs.writeFile(
    scriptPath,
    [
      "#!/bin/sh",
      "case \"$1\" in",
      "  *sername*) printf '%s\\n' \"$GIT_ASKPASS_USERNAME\" ;;",
      "  *) printf '%s\\n' \"$GIT_ASKPASS_PASSWORD\" ;;",
      "esac",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.chmod(scriptPath, 0o700);
  return { dir, scriptPath };
}

async function runGitWithAuth(input: {
  args: string[];
  cwd?: string | null;
  username: string;
  password: string;
  timeout?: number;
}) {
  const askPass = await writeAskPassScript({
    username: input.username,
    password: input.password,
  });
  try {
    const env = sanitizeGitEnv(process.env);
    env.GIT_TERMINAL_PROMPT = "0";
    env.GIT_ASKPASS = askPass.scriptPath;
    env.GIT_ASKPASS_USERNAME = input.username;
    env.GIT_ASKPASS_PASSWORD = input.password;
    return await execFile("git", input.args, {
      cwd: input.cwd ?? undefined,
      env,
      timeout: input.timeout ?? GIT_OPERATION_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
  } finally {
    await fs.rm(askPass.dir, { recursive: true, force: true }).catch(() => {});
  }
}

function gitErrorMessage(error: unknown) {
  if (error && typeof error === "object") {
    const stderr = readNonEmptyString((error as { stderr?: unknown }).stderr);
    const stdout = readNonEmptyString((error as { stdout?: unknown }).stdout);
    const message = readNonEmptyString((error as { message?: unknown }).message);
    return stderr ?? stdout ?? message ?? "Unknown git error";
  }
  return String(error);
}

function cleanGitError(error: unknown) {
  return gitErrorMessage(error).replace(/https:\/\/[^@\s]+@/g, "https://");
}

async function getProviderBinding(db: Db, companyId: string, provider: GitRepositoryProvider) {
  const binding = await db
    .select()
    .from(companyExternalAppBindings)
    .where(and(
      eq(companyExternalAppBindings.companyId, companyId),
      eq(companyExternalAppBindings.provider, provider),
    ))
    .then((rows) => rows[0] ?? null);
  if (!binding) throw unprocessable(`${provider === "github" ? "GitHub" : "Bitbucket"} integration is not configured for this company`);
  if (!binding.secretId) throw unprocessable(`${binding.displayName} integration has no token secret configured`);
  return binding;
}

async function resolveGitAuth(input: {
  db: Db;
  companyId: string;
  provider: GitRepositoryProvider;
}) {
  const binding = await getProviderBinding(input.db, input.companyId, input.provider);
  const secrets = secretService(input.db);
  const token = await secrets.resolveSecretValue(binding.companyId, binding.secretId!, "latest");
  if (input.provider === "github") {
    const config = githubExternalAppConfigSchema.parse(binding.configJson ?? {});
    return {
      binding,
      host: normalizeHost(config.host),
      username: "x-access-token",
      password: token,
    };
  }
  const config = bitbucketExternalAppConfigSchema.parse(binding.configJson ?? {});
  return {
    binding,
    host: normalizeHost(config.host),
    username: config.username,
    password: token,
  };
}

function assertProviderHost(input: {
  repoUrl: string;
  provider: GitRepositoryProvider;
  configuredHost: string;
}) {
  const parsed = parseRepoUrl(input.repoUrl);
  if (parsed.host !== input.configuredHost) {
    throw unprocessable(
      `Repository host "${parsed.host}" does not match configured ${input.provider} host "${input.configuredHost}"`,
    );
  }
  return parsed;
}

async function isGitCheckout(cwd: string) {
  return fs
    .stat(path.join(cwd, ".git"))
    .then((entry) => entry.isDirectory() || entry.isFile())
    .catch(() => false);
}

async function checkoutRef(input: {
  cwd: string;
  ref: string | null;
  username: string;
  password: string;
}) {
  if (!input.ref) return;
  await runGitWithAuth({
    args: ["checkout", input.ref],
    cwd: input.cwd,
    username: input.username,
    password: input.password,
  });
  await runGitWithAuth({
    args: ["pull", "--ff-only", "origin", input.ref],
    cwd: input.cwd,
    username: input.username,
    password: input.password,
  }).catch(() => undefined);
}

async function detectRemoteHead(input: {
  cwd: string;
  username: string;
  password: string;
}) {
  const result = await runGitWithAuth({
    args: ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    cwd: input.cwd,
    username: input.username,
    password: input.password,
  }).catch(() => null);
  return result?.stdout.trim().replace(/^origin\//, "") || null;
}

async function runPushDryRun(input: {
  cwd: string;
  username: string;
  password: string;
}) {
  try {
    await runGitWithAuth({
      args: ["push", "--dry-run", "origin", "HEAD:refs/heads/paperclip-auth-check"],
      cwd: input.cwd,
      username: input.username,
      password: input.password,
    });
    return { ok: true, message: null };
  } catch (error) {
    return { ok: false, message: cleanGitError(error) };
  }
}

async function prepareCheckout(input: {
  repoUrl: string;
  cwd: string;
  defaultRef: string | null;
  username: string;
  password: string;
}) {
  await fs.mkdir(path.dirname(input.cwd), { recursive: true });
  const stats = await fs.stat(input.cwd).catch(() => null);

  if (await isGitCheckout(input.cwd)) {
    await runGitWithAuth({
      args: ["remote", "set-url", "origin", input.repoUrl],
      cwd: input.cwd,
      username: input.username,
      password: input.password,
    });
    await runGitWithAuth({
      args: ["fetch", "--prune", "origin"],
      cwd: input.cwd,
      username: input.username,
      password: input.password,
    });
    await checkoutRef({
      cwd: input.cwd,
      ref: input.defaultRef,
      username: input.username,
      password: input.password,
    });
    return;
  }

  if (stats) {
    const entries = await fs.readdir(input.cwd).catch(() => []);
    if (entries.length > 0) {
      throw unprocessable(`Managed workspace path "${input.cwd}" already exists but is not a git checkout`);
    }
    await fs.rm(input.cwd, { recursive: true, force: true });
  }

  await runGitWithAuth({
    args: ["clone", input.repoUrl, input.cwd],
    username: input.username,
    password: input.password,
    timeout: MANAGED_WORKSPACE_GIT_CLONE_TIMEOUT_MS,
  });
  await checkoutRef({
    cwd: input.cwd,
    ref: input.defaultRef,
    username: input.username,
    password: input.password,
  });
}

export function gitRepositoryService(db: Db) {
  return {
    managedCheckoutDir(input: { companyId: string; projectId: string; repoUrl: string | null }) {
      return resolveManagedProjectWorkspaceDir({
        companyId: input.companyId,
        projectId: input.projectId,
        repoName: deriveRepoNameFromRepoUrl(input.repoUrl),
      });
    },

    prepareManagedCheckout: async (input: {
      companyId: string;
      projectId: string;
      provider: GitRepositoryProvider;
      repoUrl: string;
      defaultRef?: string | null;
      branchTemplate?: string | null;
    }): Promise<GitRepositoryOperationResult> => {
      const auth = await resolveGitAuth({
        db,
        companyId: input.companyId,
        provider: input.provider,
      });
      assertProviderHost({
        repoUrl: input.repoUrl,
        provider: input.provider,
        configuredHost: auth.host,
      });
      await runGitWithAuth({
        args: ["ls-remote", "--heads", input.repoUrl],
        username: auth.username,
        password: auth.password,
      }).catch((error) => {
        throw unprocessable(`Could not access repository: ${cleanGitError(error)}`);
      });

      const cwd = resolveManagedProjectWorkspaceDir({
        companyId: input.companyId,
        projectId: input.projectId,
        repoName: deriveRepoNameFromRepoUrl(input.repoUrl),
      });
      await prepareCheckout({
        repoUrl: input.repoUrl,
        cwd,
        defaultRef: readNonEmptyString(input.defaultRef),
        username: auth.username,
        password: auth.password,
      }).catch((error) => {
        throw unprocessable(`Could not prepare managed checkout: ${cleanGitError(error)}`);
      });
      const remoteHead = await detectRemoteHead({
        cwd,
        username: auth.username,
        password: auth.password,
      });
      const pushCheck = await runPushDryRun({
        cwd,
        username: auth.username,
        password: auth.password,
      });
      return {
        provider: input.provider,
        repoUrl: input.repoUrl,
        cwd,
        defaultRef: readNonEmptyString(input.defaultRef) ?? remoteHead,
        branchTemplate: readNonEmptyString(input.branchTemplate),
        verifiedAt: new Date().toISOString(),
        remoteHead,
        pushCheckOk: pushCheck.ok,
        pushCheckMessage: pushCheck.message,
      };
    },

    verifyProjectWorkspace: async (input: {
      companyId: string;
      projectId: string;
      workspaceId: string;
    }): Promise<GitRepositoryOperationResult> => {
      const workspace = await db
        .select()
        .from(projectWorkspaces)
        .where(and(
          eq(projectWorkspaces.companyId, input.companyId),
          eq(projectWorkspaces.projectId, input.projectId),
          eq(projectWorkspaces.id, input.workspaceId),
        ))
        .then((rows) => rows[0] ?? null);
      if (!workspace) throw notFound("Project workspace not found");
      const metadata = (workspace.metadata ?? {}) as Record<string, unknown>;
      const provider = metadata.gitProvider === "github" || metadata.gitProvider === "bitbucket"
        ? metadata.gitProvider
        : null;
      const repoUrl = readNonEmptyString(workspace.repoUrl);
      if (!provider || !repoUrl || !workspace.cwd) {
        throw unprocessable("Project workspace is not linked to a configured repository");
      }
      const auth = await resolveGitAuth({ db, companyId: input.companyId, provider });
      assertProviderHost({ repoUrl, provider, configuredHost: auth.host });
      if (!await isGitCheckout(workspace.cwd)) {
        throw unprocessable(`Workspace path "${workspace.cwd}" is not a git checkout`);
      }
      await runGitWithAuth({
        args: ["fetch", "--prune", "origin"],
        cwd: workspace.cwd,
        username: auth.username,
        password: auth.password,
      }).catch((error) => {
        throw unprocessable(`Could not fetch repository: ${cleanGitError(error)}`);
      });
      const remoteHead = await detectRemoteHead({
        cwd: workspace.cwd,
        username: auth.username,
        password: auth.password,
      });
      const pushCheck = await runPushDryRun({
        cwd: workspace.cwd,
        username: auth.username,
        password: auth.password,
      });
      return {
        provider,
        repoUrl,
        cwd: workspace.cwd,
        defaultRef: readNonEmptyString(workspace.defaultRef) ?? readNonEmptyString(workspace.repoRef) ?? remoteHead,
        branchTemplate: readNonEmptyString(metadata.branchTemplate),
        verifiedAt: new Date().toISOString(),
        remoteHead,
        pushCheckOk: pushCheck.ok,
        pushCheckMessage: pushCheck.message,
      };
    },
  };
}
