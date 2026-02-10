function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

function normalizeBasePath(basePath: string): string {
  if (!basePath || basePath === '/') {
    return '';
  }
  const withLeadingSlash = basePath.startsWith('/') ? basePath : `/${basePath}`;
  return withLeadingSlash.replace(/\/+$/, '');
}

export function getConfiguredBasePath(): string {
  const raw = process.env.NEXT_PUBLIC_APP_BASEPATH || process.env.NEXT_PUBLIC_TRENCHRIG_PATH || '';
  return normalizeBasePath(raw);
}

export function withAppBasePath(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const basePath = getConfiguredBasePath();
  if (!basePath) {
    return normalizedPath;
  }
  if (normalizedPath === basePath || normalizedPath.startsWith(`${basePath}/`)) {
    return normalizedPath;
  }
  return `${basePath}${normalizedPath}`;
}

/**
 * Build a base URL for internal server-to-server calls within the current request's origin.
 * This intentionally ignores NEXT_PUBLIC_APP_URL so misconfiguration can't break internal fetches.
 */
export function getInternalBaseUrl(origin: string): string {
  const basePath = getConfiguredBasePath();
  const normalizedOrigin = stripTrailingSlashes(origin);
  return basePath ? `${normalizedOrigin}${basePath}` : normalizedOrigin;
}

/**
 * Build the public, stable base URL for webhook URLs and external callbacks.
 * Prefer NEXT_PUBLIC_APP_URL when present; fall back to the current request origin.
 */
export function getPublicBaseUrl(origin: string): string {
  const configuredUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configuredUrl) {
    return stripTrailingSlashes(configuredUrl);
  }
  return getInternalBaseUrl(origin);
}

export function getAppBaseUrl(origin: string): string {
  // Backwards-compatible alias: historically this function returned NEXT_PUBLIC_APP_URL in production.
  // Keep that behavior for webhook URLs, while internal callers should use getInternalBaseUrl().
  return getPublicBaseUrl(origin);
}
