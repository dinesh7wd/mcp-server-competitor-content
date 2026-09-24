/** Minimal ambient types so `tsc` succeeds when optional playwright is not installed. */
declare module "playwright" {
  export const chromium: {
    launch(options?: { headless?: boolean }): Promise<{
      newContext(options?: {
        userAgent?: string;
        javaScriptEnabled?: boolean;
      }): Promise<{
        newPage(): Promise<{
          route(
            pattern: string,
            handler: (route: {
              request: () => { url: () => string };
              abort: () => Promise<void>;
              continue: () => Promise<void>;
            }) => Promise<void>,
          ): Promise<void>;
          goto(
            url: string,
            options?: { waitUntil?: string; timeout?: number },
          ): Promise<{ url: () => string } | null>;
          content(): Promise<string>;
          url(): string;
        }>;
        close(): Promise<void>;
      }>;
      close(): Promise<void>;
    }>;
  };
}
