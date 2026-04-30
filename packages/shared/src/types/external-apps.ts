export type ExternalAppProvider = "notion" | "obsidian" | "github" | "bitbucket";

export type ExternalAppStatus = "configured" | "healthy" | "error";

export interface CompanyExternalAppBinding {
  id: string;
  companyId: string;
  provider: ExternalAppProvider;
  status: ExternalAppStatus;
  displayName: string;
  secretId: string | null;
  configJson: Record<string, unknown>;
  lastCheckedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExternalAppHealthCheckResult {
  provider: ExternalAppProvider;
  status: "healthy" | "error";
  checkedAt: string;
  message: string;
  details: Record<string, unknown>;
}
