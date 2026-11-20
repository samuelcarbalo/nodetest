import { z } from "zod";

import type { CountrySummary } from "../domain/validation.js";

export type CountryLookup =
  | { status: "complete"; country: CountrySummary }
  | { status: "degraded"; reason: "timeout" | "unavailable" }
  | { status: "not_found" }
  | { status: "ambiguous" };

export type CountryLookupClient = {
  lookup(name: string): Promise<CountryLookup>;
};

type CountryList =
  | { status: "ok"; countries: CountrySummary[] }
  | { status: "degraded"; reason: "timeout" | "unavailable" };

/**
 * CountryStateCity devuelve un solo nombre en inglés (`name`), el código
 * `iso2`, `region` y `capital`. No hay nombre oficial distinto: officialName
 * reutiliza `name` y cca2 guarda `iso2`.
 */
const cscCountrySchema = z
  .object({
    name: z.string().trim().min(1),
    iso2: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/),
    region: z.string().trim().min(1),
    capital: z.string().trim().nullable().optional(),
  })
  .transform((country): CountrySummary => ({
    commonName: country.name,
    officialName: country.name,
    cca2: country.iso2.toUpperCase(),
    region: country.region,
    capital: country.capital ? country.capital : null,
  }));

/**
 * GET {base}/countries con la cabecera X-CSCAPI-KEY.
 * La lista completa se cachea en memoria solo después de un 2xx interpretable.
 * Un timeout, un HTTP de error o un cuerpo inválido no se cachean.
 * Sin CSC_API_KEY no se llama a la red y la búsqueda queda degradada.
 */
export class CountriesClient implements CountryLookupClient {
  private cache: CountrySummary[] | null = null;
  private inflight: Promise<CountryList> | null = null;
  private warnedMissingKey = false;

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly apiKey?: string,
  ) {}

  async lookup(name: string): Promise<CountryLookup> {
    const apiKey = this.apiKey?.trim();
    if (!apiKey) {
      if (!this.warnedMissingKey) {
        this.warnedMissingKey = true;
        console.warn("CSC_API_KEY is not set; country enrichment will be stored as degraded");
      }
      return { status: "degraded", reason: "unavailable" };
    }

    const loaded = await this.loadCountries(apiKey);
    if (loaded.status !== "ok") {
      return loaded;
    }
    return matchCountry(name, loaded.countries);
  }

  private loadCountries(apiKey: string): Promise<CountryList> {
    if (this.cache) {
      return Promise.resolve({ status: "ok", countries: this.cache });
    }
    if (!this.inflight) {
      this.inflight = this.fetchCountries(apiKey).finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async fetchCountries(apiKey: string): Promise<CountryList> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const url = new URL(`${this.baseUrl.replace(/\/$/, "")}/countries`);
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "X-CSCAPI-KEY": apiKey,
        },
      });
      const body = await readBody(response);
      const parsed = parseCountryList(response.status, body);
      if (parsed.status === "ok") {
        this.cache = parsed.countries;
      }
      return parsed;
    } catch (error) {
      if (controller.signal.aborted || isTimeoutError(error)) {
        return { status: "degraded", reason: "timeout" };
      }
      console.warn("country lookup failed", error instanceof Error ? error.message : error);
      return { status: "degraded", reason: "unavailable" };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function interpretLookup(query: string, status: number, body: unknown): CountryLookup {
  const parsed = parseCountryList(status, body);
  if (parsed.status !== "ok") {
    return parsed;
  }
  return matchCountry(query, parsed.countries);
}

function parseCountryList(status: number, body: unknown): CountryList {
  if (status < 200 || status >= 300 || !Array.isArray(body)) {
    return { status: "degraded", reason: "unavailable" };
  }

  const countries: CountrySummary[] = [];
  for (const entry of body) {
    const parsed = cscCountrySchema.safeParse(entry);
    if (parsed.success) {
      countries.push(parsed.data);
    }
  }

  if (countries.length === 0) {
    return { status: "degraded", reason: "unavailable" };
  }
  return { status: "ok", countries };
}

function matchCountry(query: string, countries: CountrySummary[]): CountryLookup {
  const needle = normalizeName(query);
  const matchesCode = /^[a-z]{2}$/.test(needle);
  const matches = countries.filter((country) => {
    if (normalizeName(country.commonName) === needle) {
      return true;
    }
    return matchesCode && normalizeName(country.cca2) === needle;
  });

  const match = matches[0];
  if (!match) {
    return { status: "not_found" };
  }
  if (matches.length > 1) {
    return { status: "ambiguous" };
  }
  return { status: "complete", country: match };
}

function normalizeName(value: string): string {
  return value.trim().toLocaleLowerCase("en");
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) {
    return null;
  }
  if (text.length > 5_000_000) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
