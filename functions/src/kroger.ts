/**
 * Minimal Kroger Public API client (https://developer.kroger.com).
 * Uses the client-credentials flow, which only needs the app's client ID and secret.
 */

const BASE = "https://api.kroger.com/v1";
const USER_AGENT = "Chuckwagon/0.1 (grocery deal meal planner)";

export interface KrogerStore {
  locationId: string;
  chain: string;
  /** Kroger division; stores in one division share the weekly ad. */
  divisionNumber?: string;
  name: string;
  address: { addressLine1?: string; city?: string; state?: string; zipCode?: string };
  geolocation?: { latitude: number; longitude: number };
}

export interface KrogerProduct {
  productId: string;
  upc?: string;
  brand?: string;
  description: string;
  categories?: string[];
  images?: { perspective: string; sizes: { size: string; url: string }[] }[];
  items?: {
    size?: string;
    soldBy?: string;
    price?: { regular: number; promo: number };
  }[];
}

export class KrogerClient {
  private token?: { value: string; expiresAt: number };

  constructor(private clientId: string, private clientSecret: string) {}

  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - 60_000) return this.token.value;
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
    const res = await fetch(`${BASE}/connect/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body: "grant_type=client_credentials&scope=product.compact",
    });
    if (!res.ok) throw new Error(`Kroger token request failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    return this.token.value;
  }

  private async get<T>(path: string, params: Record<string, string | number>): Promise<T> {
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(`${BASE}${path}?${qs}`, {
        headers: {
          Authorization: `Bearer ${await this.getToken()}`,
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
      });
      if (res.ok) return (await res.json()) as T;
      // Back off on rate limits and transient server errors.
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      throw new Error(`Kroger GET ${path} failed: ${res.status} ${await res.text()}`);
    }
  }

  async storesNear(zip: string, radiusMiles: number, limit: number): Promise<KrogerStore[]> {
    const json = await this.get<{ data: KrogerStore[] }>("/locations", {
      "filter.zipCode.near": zip,
      "filter.radiusInMiles": radiusMiles,
      "filter.limit": limit,
    });
    return json.data;
  }

  async searchProducts(term: string, locationId: string, start: number, limit: number): Promise<KrogerProduct[]> {
    const json = await this.get<{ data: KrogerProduct[] }>("/products", {
      "filter.term": term,
      "filter.locationId": locationId,
      "filter.limit": limit,
      // Omit start on the first page; later pages skip the results already seen.
      ...(start > 0 ? { "filter.start": start } : {}),
    });
    return json.data ?? [];
  }
}
