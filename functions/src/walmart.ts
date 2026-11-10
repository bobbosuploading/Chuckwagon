/**
 * Minimal Walmart Affiliate API client (https://walmart.io, "Affiliates" APIs).
 *
 * Every request is signed with the RSA private key whose public half was uploaded
 * to walmart.io. The signed text is "consumerId\ntimestamp\nkeyVersion\n".
 */
import { createSign } from "node:crypto";

const BASE = "https://developer.api.walmart.com/api-proxy/service/affil/product/v2";

export interface WalmartStore {
  no: number;
  name: string;
  streetAddress?: string;
  city?: string;
  stateProvCode?: string;
  zip?: string;
  /** [longitude, latitude] */
  coordinates?: number[];
}

export interface WalmartItem {
  itemId: number;
  name: string;
  brandName?: string;
  upc?: string;
  categoryPath?: string;
  msrp?: number;
  salePrice?: number;
  /** "Was" price Walmart shows crossed out, when there is one. */
  strikeThroughPrice?: number;
  rollBack?: boolean;
  clearance?: boolean;
  specialBuy?: boolean;
  /** Sold by a third-party seller instead of Walmart. */
  marketplace?: boolean;
  /** ONLINE_ONLY or ONLINE_AND_STORE. */
  offerType?: string;
  stock?: string;
  availableOnline?: boolean;
  mediumImage?: string;
  thumbnailImage?: string;
  productTrackingUrl?: string;
  attributes?: Record<string, string>;
}

export interface WalmartAuth {
  consumerId: string;
  /** PEM text of the private key (BEGIN PRIVATE KEY or BEGIN RSA PRIVATE KEY). */
  privateKey: string;
  keyVersion: string;
  /** Impact publisher ID. Optional; adds affiliate tracking to product links. */
  publisherId?: string;
}

export class WalmartClient {
  apiCalls = 0;

  constructor(private auth: WalmartAuth) {}

  private headers(): Record<string, string> {
    const ts = Date.now().toString();
    const signer = createSign("RSA-SHA256");
    signer.update(`${this.auth.consumerId}\n${ts}\n${this.auth.keyVersion}\n`);
    return {
      "WM_CONSUMER.ID": this.auth.consumerId,
      "WM_CONSUMER.INTIMESTAMP": ts,
      "WM_SEC.KEY_VERSION": this.auth.keyVersion,
      "WM_SEC.AUTH_SIGNATURE": signer.sign(this.auth.privateKey, "base64"),
      Accept: "application/json",
    };
  }

  private async get<T>(path: string, params: Record<string, string | number | undefined>): Promise<T> {
    const all = { ...params, ...(this.auth.publisherId ? { publisherId: this.auth.publisherId } : {}) };
    const qs = new URLSearchParams(
      Object.entries(all).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)])
    );
    for (let attempt = 1; ; attempt++) {
      this.apiCalls++;
      const res = await fetch(`${BASE}${path}?${qs}`, { headers: this.headers() });
      if (res.ok) return (await res.json()) as T;
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      throw new Error(`Walmart GET ${path} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    }
  }

  async storesNear(zip: string): Promise<WalmartStore[]> {
    const json = await this.get<WalmartStore[] | { stores?: WalmartStore[] }>("/stores", { zip });
    return Array.isArray(json) ? json : json.stores ?? [];
  }

  /** Keyword search (no ZIP pricing; used only to find item IDs). Max 25 per page. */
  async search(query: string, categoryId?: string, numItems = 25): Promise<WalmartItem[]> {
    const json = await this.get<{ items?: WalmartItem[] }>("/search", {
      query,
      categoryId,
      numItems,
      sort: "bestseller",
    });
    return json.items ?? [];
  }

  /** Price and availability for up to 20 item IDs, priced for `zip`. */
  async lookup(ids: number[], zip: string): Promise<WalmartItem[]> {
    if (ids.length > 20) throw new Error("Walmart lookup takes at most 20 IDs");
    const json = await this.get<{ items?: WalmartItem[] }>("/items", { ids: ids.join(","), zipCode: zip });
    return json.items ?? [];
  }
}
