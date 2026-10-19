export interface ErrorBody {
  status_code?: number;
  error?: string;
  message?: string;
  required_tier?: string;
  current_tier?: string;
  upgrade_url?: string;
  retry_after?: number;
  retry_after_s?: number;
  reset?: number;
  [key: string]: unknown;
}

const PRICING_URL = 'https://tik.tools/pricing';

export class TikToolsError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly endpoint: string;

  constructor(message: string, status: number, body: unknown, endpoint: string) {
    super(message);
    this.name = 'TikToolsError';
    this.status = status;
    this.body = body;
    this.endpoint = endpoint;
  }
}

export class AuthError extends TikToolsError {
  readonly upgradeUrl: string;
  constructor(message: string, status: number, body: unknown, endpoint: string) {
    super(message, status, body, endpoint);
    this.name = 'AuthError';
    this.upgradeUrl = (asBody(body).upgrade_url as string) || PRICING_URL;
  }
}

export class PaymentRequiredError extends TikToolsError {
  readonly upgradeUrl: string;
  constructor(message: string, status: number, body: unknown, endpoint: string) {
    super(message, status, body, endpoint);
    this.name = 'PaymentRequiredError';
    this.upgradeUrl = (asBody(body).upgrade_url as string) || PRICING_URL;
  }
}

/** The key works but its plan does not include this call. Render an upgrade card instead of crashing. */
export class PlanRequiredError extends TikToolsError {
  readonly requiredTier: string | undefined;
  readonly currentTier: string | undefined;
  readonly upgradeUrl: string;
  constructor(message: string, status: number, body: unknown, endpoint: string, fallbackTier?: string) {
    super(message, status, body, endpoint);
    this.name = 'PlanRequiredError';
    const b = asBody(body);
    this.requiredTier = (b.required_tier as string) || fallbackTier;
    this.currentTier = b.current_tier as string | undefined;
    this.upgradeUrl = (b.upgrade_url as string) || PRICING_URL;
  }
}

export class NotFoundError extends TikToolsError {
  constructor(message: string, status: number, body: unknown, endpoint: string) {
    super(message, status, body, endpoint);
    this.name = 'NotFoundError';
  }
}

/** 409: 50 rosters per account or 1000 creators per roster. */
export class RosterLimitError extends TikToolsError {
  constructor(message: string, status: number, body: unknown, endpoint: string) {
    super(message, status, body, endpoint);
    this.name = 'RosterLimitError';
  }
}

export class ValidationError extends TikToolsError {
  constructor(message: string, status: number, body: unknown, endpoint: string) {
    super(message, status, body, endpoint);
    this.name = 'ValidationError';
  }
}

export class RateLimitError extends TikToolsError {
  /** Seconds to wait before retrying. */
  readonly retryAfter: number;
  constructor(message: string, status: number, body: unknown, endpoint: string, retryAfter: number) {
    super(message, status, body, endpoint);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

export class ServerError extends TikToolsError {
  constructor(message: string, status: number, body: unknown, endpoint: string) {
    super(message, status, body, endpoint);
    this.name = 'ServerError';
  }
}

export class NetworkError extends TikToolsError {
  readonly cause: unknown;
  constructor(message: string, endpoint: string, cause?: unknown) {
    super(message, 0, null, endpoint);
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

export class WebhookSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookSignatureError';
  }
}

export function asBody(body: unknown): ErrorBody {
  return body && typeof body === 'object' ? (body as ErrorBody) : {};
}

/** Seconds to wait, from the body (retry_after, retry_after_s, reset) or headers (Retry-After, X-RateLimit-Reset). */
export function retryAfterSeconds(body: unknown, headers?: { get(name: string): string | null }, nowMs = Date.now()): number {
  const b = asBody(body);
  const direct = Number(b.retry_after ?? b.retry_after_s);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const header = Number(headers?.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return header;
  const reset = Number(b.reset ?? headers?.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) return Math.max(1, Math.ceil(reset - nowMs / 1000));
  return 60;
}

export function errorFromResponse(
  status: number,
  body: unknown,
  endpoint: string,
  headers?: { get(name: string): string | null },
  minTier?: string,
): TikToolsError {
  const b = asBody(body);
  const text = typeof body === 'string' && body ? body.slice(0, 200) : '';
  const message = [b.error, b.message].filter(Boolean).join(' - ') || text || `Request failed with HTTP ${status}`;
  if (status === 401) return new AuthError(message, status, body, endpoint);
  if (status === 402) return new PaymentRequiredError(message, status, body, endpoint);
  if (status === 403) {
    // Evaluation-ended and suspended keys are 403 too, but they are not a plan gap.
    if (/evaluation|suspend|banned|inactive|revoked/i.test(message) && !b.required_tier) {
      return new AuthError(message, status, body, endpoint);
    }
    return new PlanRequiredError(message, status, body, endpoint, minTier);
  }
  if (status === 404) return new NotFoundError(message, status, body, endpoint);
  if (status === 409) return new RosterLimitError(message, status, body, endpoint);
  if (status === 400 || status === 422) return new ValidationError(message, status, body, endpoint);
  if (status === 429) return new RateLimitError(message, status, body, endpoint, retryAfterSeconds(body, headers));
  if (status >= 500) return new ServerError(message, status, body, endpoint);
  return new TikToolsError(message, status, body, endpoint);
}
