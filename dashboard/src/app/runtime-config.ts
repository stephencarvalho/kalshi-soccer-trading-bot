export interface DashboardRuntimeConfig {
  apiBaseUrl: string;
  apiToken: string;
}

declare global {
  interface Window {
    __DASHBOARD_RUNTIME__?: Partial<DashboardRuntimeConfig>;
  }
}

function sanitizeBaseUrl(value: string | undefined): string {
  return String(value || '').trim().replace(/\/+$/, '');
}

export function getDashboardRuntimeConfig(): DashboardRuntimeConfig {
  const runtime = window.__DASHBOARD_RUNTIME__ || {};

  return {
    apiBaseUrl: sanitizeBaseUrl(runtime.apiBaseUrl),
    apiToken: String(runtime.apiToken || '').trim(),
  };
}

export function buildApiUrl(pathname: string): string {
  const { apiBaseUrl } = getDashboardRuntimeConfig();
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return apiBaseUrl ? `${apiBaseUrl}${normalizedPath}` : normalizedPath;
}
