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

export function getAppBaseUrl(origin: string): string {
  const basePath = getConfiguredBasePath();
  if (process.env.NODE_ENV === 'development') {
    const normalizedOrigin = stripTrailingSlashes(origin);
    return basePath ? `${normalizedOrigin}${basePath}` : normalizedOrigin;
  }

  const configuredUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configuredUrl) {
    return stripTrailingSlashes(configuredUrl);
  }
  const normalizedOrigin = stripTrailingSlashes(origin);
  return basePath ? `${normalizedOrigin}${basePath}` : normalizedOrigin;
}
