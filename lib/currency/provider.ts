import "server-only";

export type FxSnapshot = { baseCurrency: "USD"; provider: string; providerTimestamp: string; fetchedAt: string; rates: Record<string, number> };
export interface FxProvider { fetchLatest(): Promise<FxSnapshot>; }

