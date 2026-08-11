import { z } from "zod";

import {
  readBoundedResponseJson,
  readBoundedResponseText,
} from "~/platform/http/read-response";

const PROVIDER_REQUEST_TIMEOUT_MS = 20_000;
const PROVIDER_RESPONSE_MAX_BYTES = 512 * 1_024;

export class ResendDomainConfigurationError extends Error {
  constructor(
    message = "RESEND_API_KEY is required to provision a sender domain.",
  ) {
    super(message);
    this.name = "ResendDomainConfigurationError";
  }
}

export class ResendDomainRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ResendDomainRequestError";
  }
}

const domainIdSchema = z.string().min(1).max(512);
const domainSchema = z.object({
  id: domainIdSchema,
  name: z.string().min(1).max(255),
  status: z.string().min(1).max(64),
  records: z.array(z.unknown()).optional(),
});

const domainListSchema = z.object({ data: z.array(domainSchema) });

async function providerError(response: Response): Promise<never> {
  const body = await readBoundedResponseText(
    response,
    PROVIDER_RESPONSE_MAX_BYTES,
  ).catch(() => "");
  let message = `Resend returned HTTP ${response.status}.`;
  if (body) {
    try {
      const parsed = z
        .object({ message: z.string().min(1) })
        .safeParse(JSON.parse(body));
      if (parsed.success) message = parsed.data.message;
    } catch {
      // The HTTP status is authoritative when the provider response is not JSON.
    }
  }
  throw new ResendDomainRequestError(response.status, message.slice(0, 500));
}

export type ResendDomain = z.infer<typeof domainSchema>;

export class ResendDomainProvider {
  constructor(
    private readonly apiKey: string | undefined,
    private readonly fetcher: typeof fetch = fetch,
    private readonly baseUrl = "https://api.resend.com",
  ) {}

  private headers(json = false) {
    if (!this.apiKey?.trim()) throw new ResendDomainConfigurationError();
    return {
      authorization: `Bearer ${this.apiKey}`,
      ...(json ? { "content-type": "application/json" } : {}),
    };
  }

  async list() {
    const response = await this.fetcher(`${this.baseUrl}/domains`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) await providerError(response);
    const parsed = domainListSchema.safeParse(
      await readBoundedResponseJson(
        response,
        PROVIDER_RESPONSE_MAX_BYTES,
      ).catch(() => null),
    );
    if (!parsed.success)
      throw new ResendDomainRequestError(
        response.status,
        "Resend returned an invalid domain list.",
      );
    return parsed.data.data;
  }

  async create(name: string) {
    const response = await this.fetcher(`${this.baseUrl}/domains`, {
      method: "POST",
      headers: this.headers(true),
      signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
      body: JSON.stringify({ name }),
    });
    if (!response.ok) await providerError(response);
    const parsed = domainSchema.safeParse(
      await readBoundedResponseJson(
        response,
        PROVIDER_RESPONSE_MAX_BYTES,
      ).catch(() => null),
    );
    if (!parsed.success)
      throw new ResendDomainRequestError(
        response.status,
        "Resend did not return the registered sender domain.",
      );
    return parsed.data;
  }

  async verify(id: string) {
    if (!domainIdSchema.safeParse(id).success)
      throw new ResendDomainConfigurationError(
        "The saved Resend domain identifier is invalid.",
      );
    const response = await this.fetcher(
      `${this.baseUrl}/domains/${encodeURIComponent(id)}/verify`,
      {
        method: "POST",
        headers: this.headers(),
        signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
      },
    );
    if (!response.ok) await providerError(response);
  }

  async get(id: string) {
    if (!domainIdSchema.safeParse(id).success)
      throw new ResendDomainConfigurationError(
        "The saved Resend domain identifier is invalid.",
      );
    const response = await this.fetcher(
      `${this.baseUrl}/domains/${encodeURIComponent(id)}`,
      {
        headers: this.headers(),
        signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
      },
    );
    if (!response.ok) await providerError(response);
    const parsed = domainSchema.safeParse(
      await readBoundedResponseJson(
        response,
        PROVIDER_RESPONSE_MAX_BYTES,
      ).catch(() => null),
    );
    if (!parsed.success)
      throw new ResendDomainRequestError(
        response.status,
        "Resend returned invalid sender-domain status.",
      );
    return parsed.data;
  }
}
