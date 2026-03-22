export interface DashboardRuntimeConfig {
  apiBaseUrl: string;
  apiToken: string;
  monitorPort: string;
}

declare global {
  interface Window {
    __DASHBOARD_RUNTIME__?: Partial<DashboardRuntimeConfig>;
  }
}

function sanitizeBaseUrl(value: string | undefined): string {
  return String(value || '').trim().replace(/\/+$/, '');
}

function sanitizePort(value: string | undefined): string {
  const trimmed = String(value || '').trim();
  return /^\d+$/.test(trimmed) ? trimmed : '8787';
}

function inferDevApiBaseUrl(monitorPort: string): string {
  const hostname = String(window.location?.hostname || '').trim();
  const protocol = String(window.location?.protocol || 'http:').trim() || 'http:';
  const port = String(window.location?.port || '').trim();
  const devPorts = new Set(['4200', '4201', '4300']);

  if (!hostname || !devPorts.has(port)) return '';
  return `${protocol}//${hostname}:${monitorPort}`;
}

export function getDashboardRuntimeConfig(): DashboardRuntimeConfig {
  const runtime = window.__DASHBOARD_RUNTIME__ || {};
  const monitorPort = sanitizePort((runtime as Partial<DashboardRuntimeConfig>).monitorPort);
  const apiBaseUrl = sanitizeBaseUrl(runtime.apiBaseUrl) || inferDevApiBaseUrl(monitorPort);

  return {
    apiBaseUrl,
    apiToken: String(runtime.apiToken || '').trim(),
    monitorPort,
  };
}

export function buildApiUrl(pathname: string): string {
  const { apiBaseUrl } = getDashboardRuntimeConfig();
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return apiBaseUrl ? `${apiBaseUrl}${normalizedPath}` : normalizedPath;
}
