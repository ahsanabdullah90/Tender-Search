export interface ApiErrorDetail {
  field: string;
  message: string;
}

export class ApiError extends Error {
  status: number;
  data: unknown;
  readonly code?: string;
  readonly details?: ApiErrorDetail[];

  constructor(
    status: number,
    message: string,
    data?: unknown,
    code?: string,
    details?: ApiErrorDetail[]
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
    if (code !== undefined) {
      this.code = code;
    }
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = init ? await fetch(url, init) : await fetch(url);
  const data = typeof res.json === 'function' ? await res.json().catch(() => null) : null;
  if (!res.ok || (data && typeof data === 'object' && 'success' in data && (data as { success?: boolean }).success === false)) {
    const payload = data as {
      message?: string;
      error?: string;
      code?: unknown;
      details?: unknown;
    } | null;
    const message = payload?.message || payload?.error || `HTTP ${res.status || 500}`;
    const code = typeof payload?.code === 'string' && payload.code ? payload.code : undefined;
    const details = Array.isArray(payload?.details)
      ? payload.details.filter(
          (item): item is ApiErrorDetail =>
            Boolean(item) &&
            typeof item === 'object' &&
            typeof (item as { field?: unknown }).field === 'string' &&
            typeof (item as { message?: unknown }).message === 'string'
        )
      : undefined;
    throw new ApiError(res.status || 500, message, data, code, details);
  }
  return data as T;
}

export async function apiMutate<T = unknown>(
  url: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body?: unknown
): Promise<T> {
  const init: RequestInit =
    body === undefined
      ? { method }
      : {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        };
  return apiJson<T>(url, init);
}
