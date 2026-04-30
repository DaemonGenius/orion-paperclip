import type {
  CompanyExternalAppBinding,
  ExternalAppHealthCheckResult,
  ExternalAppProvider,
} from "@paperclipai/shared";
import { api } from "./client";

export interface ExternalAppRepository {
  provider: "github" | "bitbucket";
  host: string;
  owner: string;
  name: string;
  fullName: string;
  cloneUrl: string;
  defaultBranch: string | null;
  private: boolean;
  archived: boolean;
  description: string | null;
  updatedAt: string | null;
}

export const externalAppsApi = {
  list: (companyId: string) =>
    api.get<CompanyExternalAppBinding[]>(`/companies/${companyId}/external-apps`),
  create: (
    companyId: string,
    provider: ExternalAppProvider,
    data: {
      displayName?: string;
      secretId?: string | null;
      token?: string | null;
      config?: Record<string, unknown>;
    },
  ) => api.post<CompanyExternalAppBinding>(`/companies/${companyId}/external-apps/${provider}`, data),
  update: (
    bindingId: string,
    data: {
      displayName?: string;
      secretId?: string | null;
      token?: string | null;
      config?: Record<string, unknown>;
    },
  ) => api.patch<CompanyExternalAppBinding>(`/external-apps/${bindingId}`, data),
  test: (bindingId: string) =>
    api.post<{ binding: CompanyExternalAppBinding; result: ExternalAppHealthCheckResult }>(
      `/external-apps/${bindingId}/test`,
      {},
    ),
  repositories: (bindingId: string, query?: string) => {
    const params = query?.trim() ? `?q=${encodeURIComponent(query.trim())}` : "";
    return api.get<{ repositories: ExternalAppRepository[] }>(`/external-apps/${bindingId}/repositories${params}`);
  },
  remove: (bindingId: string) =>
    api.delete<{ ok: true; binding: CompanyExternalAppBinding | null }>(`/external-apps/${bindingId}`),
};
