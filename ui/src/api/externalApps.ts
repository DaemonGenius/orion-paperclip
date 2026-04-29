import type {
  CompanyExternalAppBinding,
  ExternalAppHealthCheckResult,
  ExternalAppProvider,
} from "@paperclipai/shared";
import { api } from "./client";

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
  remove: (bindingId: string) =>
    api.delete<{ ok: true; binding: CompanyExternalAppBinding | null }>(`/external-apps/${bindingId}`),
};
