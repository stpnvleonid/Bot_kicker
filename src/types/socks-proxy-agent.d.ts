declare module 'socks-proxy-agent' {
  import type { Agent } from 'http';
  export class SocksProxyAgent extends Agent {
    constructor(uri: string, opts?: any);
  }
}

