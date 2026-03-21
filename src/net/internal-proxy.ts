import type { Agent as HttpAgent } from 'node:http';
import type { SocksProxyAgent } from 'socks-proxy-agent';

export type ProxyConfig = {
  /**
   * Socks URL, e.g. `socks5h://127.0.0.1:1080`.
   * Default matches the proxy in the `/proxy` folder (Tg WS Proxy).
   */
  socksUrl: string;
};

function normalizeSocksUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  // Allow `127.0.0.1:1080` format.
  if (!s.includes('://') && s.includes(':')) return `socks5h://${s}`;
  return s;
}

function parseSocksUrlList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,\n;]+/g)
    .map((x) => normalizeSocksUrl(x))
    .filter((x): x is string => !!x);
}

function hasExplicitTelegramProxyUrls(): boolean {
  const listFromEnv = process.env.TELEGRAM_SOCKS_PROXY_URLS;
  if (listFromEnv && parseSocksUrlList(listFromEnv).length > 0) return true;
  const single = process.env.INTERNAL_SOCKS_PROXY_URL?.trim();
  return !!normalizeSocksUrl(single ?? '');
}

/**
 * SOCKS для Telegram — **по умолчанию выключен** (прямое подключение к api.telegram.org).
 * В Docker `127.0.0.1:1080` — это контейнер, не хост; включение по умолчанию давало «тишину» в логах из‑за долгого/зависшего коннекта к прокси.
 *
 * Включить: `TELEGRAM_SOCKS_PROXY_ENABLED=1` или задать `TELEGRAM_SOCKS_PROXY_URLS` / `INTERNAL_SOCKS_PROXY_URL`.
 */
export function isTelegramProxyEnabled(): boolean {
  if (process.env.INTERNAL_SOCKS_PROXY_ENABLED === '0') return false;
  if (process.env.TELEGRAM_SOCKS_PROXY_ENABLED === '0') return false;
  if (process.env.TELEGRAM_SOCKS_PROXY_ENABLED === '1') return true;
  if (process.env.INTERNAL_SOCKS_PROXY_ENABLED === '1') return true;
  return hasExplicitTelegramProxyUrls();
}

function getTelegramSocksProxyUrls(): string[] {
  const listFromEnv = process.env.TELEGRAM_SOCKS_PROXY_URLS;
  const parsedList = parseSocksUrlList(listFromEnv);
  if (parsedList.length) return parsedList;

  // Backward compatibility: single value.
  const single = process.env.INTERNAL_SOCKS_PROXY_URL?.trim();
  const normalizedSingle = normalizeSocksUrl(single ?? '');
  if (normalizedSingle) return [normalizedSingle];

  // Не подставляем 127.0.0.1:1080 по умолчанию: в Docker это **контейнер**, не хост → ECONNREFUSED.
  // Локальная разработка с прокси на машине: явно URL или TELEGRAM_SOCKS_PROXY_DEFAULT_LOCAL=1
  const defaultLocal =
    process.env.TELEGRAM_SOCKS_PROXY_DEFAULT_LOCAL === '1' ||
    process.env.TELEGRAM_SOCKS_PROXY_DEFAULT_LOCAL === 'true';
  if (defaultLocal && isTelegramProxyEnabled()) {
    return ['socks5h://127.0.0.1:1080'];
  }
  return [];
}

/**
 * SOCKS включён, но нет ни одного URL — иначе раньше подставлялся 127.0.0.1:1080 и ломал Docker.
 */
export function validateTelegramSocksProxyEnv(): void {
  if (!isTelegramProxyEnabled()) return;
  if (getTelegramSocksProxyUrls().length > 0) return;
  console.error(
    '[Startup] Fatal: SOCKS включён (TELEGRAM_SOCKS_PROXY_ENABLED=1 или явные URL), но список прокси пуст. ' +
      'Задайте TELEGRAM_SOCKS_PROXY_URLS=socks5h://user:pass@HOST:PORT (реальный удалённый SOCKS5). ' +
      'В Docker 127.0.0.1 — это не хост-машина. Локально у себя на ПК с прокси на :1080: ' +
      'TELEGRAM_SOCKS_PROXY_URLS=socks5h://127.0.0.1:1080 или TELEGRAM_SOCKS_PROXY_DEFAULT_LOCAL=1. ' +
      'См. docs/TELEGRAM_SOCKS_PROXY.md'
  );
  process.exit(1);
}

let cachedTelegramProxyUrlsKey: string | undefined;
let cachedTelegramProxyAgents: SocksProxyAgent[] | null = null;

async function getInternalProxyAgentsAsync(): Promise<SocksProxyAgent[]> {
  if (!isTelegramProxyEnabled()) return [];
  const urls = getTelegramSocksProxyUrls();
  const key = urls.join('|');
  if (cachedTelegramProxyAgents && cachedTelegramProxyUrlsKey === key) {
    return cachedTelegramProxyAgents;
  }

  // socks-proxy-agent is ESM-only; load it dynamically to keep CJS runtime compatibility.
  const mod = await import('socks-proxy-agent');
  const SocksProxyAgentCtor = mod.SocksProxyAgent as unknown as typeof SocksProxyAgent;

  cachedTelegramProxyUrlsKey = key;
  cachedTelegramProxyAgents = urls.map((u) => new (SocksProxyAgentCtor as any)(u));
  return cachedTelegramProxyAgents;
}

/**
 * Агент для `new Telegraf(token, { telegram: { agent } })`.
 * Telegraf вызывает Telegram API через **node-fetch** с этим агентом, а не через `global fetch`,
 * поэтому без этого SOCKS к api.telegram.org не применяется (в отличие от `enableFetchProxyFallback`).
 */
export async function getTelegramNodeFetchAgent(): Promise<HttpAgent | undefined> {
  const agents = await getInternalProxyAgentsAsync();
  const first = agents[0];
  return first as HttpAgent | undefined;
}

function isLikelyProxyNetworkError(err: unknown): boolean {
  const msg = String((err as any)?.message ?? err ?? '');
  const code = String((err as any)?.code ?? (err as any)?.errno ?? '');
  return (
    msg.includes('ECONNRESET') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('ENOTFOUND') ||
    msg.includes('EAI_AGAIN') ||
    msg.includes('EHOSTUNREACH') ||
    msg.includes('socket hang up') ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN'
  );
}

function isTelegramApiUrl(url: URL): boolean {
  // Telegraf talks to Telegram Bot API on `api.telegram.org`.
  return url.hostname === 'api.telegram.org';
}

function getUrlFromFetchInput(input: RequestInfo | URL): URL | null {
  if (input instanceof URL) return input;
  if (typeof input === 'string') {
    try {
      return new URL(input);
    } catch {
      return null;
    }
  }
  // Request-like object
  const anyInput: any = input as any;
  if (anyInput?.url) {
    try {
      return new URL(anyInput.url);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Wrap global `fetch` so that only Telegram Bot API calls are proxied:
 * 1) try SOCKS proxies from `TELEGRAM_SOCKS_PROXY_URLS` one by one
 * 2) if all proxy attempts fail with network/proxy-like errors -> try direct (no agent)
 *
 * All non-Telegram requests are executed directly as-is.
 */
export function enableFetchProxyFallback(): void {
  // Avoid double-wrapping.
  const g = globalThis as any;
  if (g.__telegramProxyFetchWrapped) return;
  g.__telegramProxyFetchWrapped = true;

  const originalFetch: typeof fetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlObj = getUrlFromFetchInput(input as any);
    if (!urlObj || !isTelegramApiUrl(urlObj)) {
      return originalFetch(input, init);
    }

    const proxyAgents = await getInternalProxyAgentsAsync();
    if (!proxyAgents.length) return originalFetch(input, init);

    const baseInit: any = init ? { ...init } : {};

    let lastErr: unknown = undefined;
    for (const agent of proxyAgents) {
      try {
        const attemptInit = { ...baseInit, agent };
        return await originalFetch(urlObj, attemptInit);
      } catch (err) {
        lastErr = err;
        if (!isLikelyProxyNetworkError(err)) throw err;
      }
    }

    // Direct fallback: drop agent.
    const directInit = { ...baseInit, agent: undefined };
    return originalFetch(urlObj, directInit).catch((e) => {
      // Keep original proxy error if direct fails too.
      throw lastErr ?? e;
    });
  }) as any;
}

