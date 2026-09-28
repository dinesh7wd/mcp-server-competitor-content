/** Minimal ambient types so `tsc` succeeds when optional playwright is not installed. */
declare module "playwright" {
  export interface Route {
    request(): { url(): string };
    abort(): Promise<void>;
    continue(): Promise<void>;
  }

  export interface WebSocketRoute {
    close(options?: { code?: number; reason?: string }): Promise<void>;
  }

  export interface Response {
    url(): string;
  }

  export interface Page {
    goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<Response | null>;
    waitForLoadState(
      state?: "load" | "domcontentloaded" | "networkidle",
      options?: { timeout?: number },
    ): Promise<void>;
    content(): Promise<string>;
    url(): string;
  }

  export interface BrowserContext {
    route(pattern: string, handler: (route: Route) => Promise<void>): Promise<void>;
    /** Playwright >= 1.48. */
    routeWebSocket?(
      pattern: string | RegExp,
      handler: (ws: WebSocketRoute) => Promise<void> | void,
    ): Promise<void>;
    newPage(): Promise<Page>;
    close(): Promise<void>;
  }

  export interface Browser {
    newContext(options?: {
      userAgent?: string;
      javaScriptEnabled?: boolean;
      serviceWorkers?: "allow" | "block";
    }): Promise<BrowserContext>;
    close(): Promise<void>;
  }

  export const chromium: {
    launch(options?: { headless?: boolean }): Promise<Browser>;
  };
}
