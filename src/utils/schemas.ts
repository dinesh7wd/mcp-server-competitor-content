import { z } from "zod";

/** Fresh instance per use: shared Zod instances become `$ref`s in the generated JSON Schema. */
function urlField(
  description = "Public http(s) URL to fetch (private/localhost targets are blocked)",
): z.ZodEffects<z.ZodString, string, string> {
  return z
    .string()
    .url()
    .refine((u) => u.startsWith("http://") || u.startsWith("https://"), {
      message: "Only http(s) URLs are allowed",
    })
    .describe(description);
}

export const DEFAULT_SCRAPE_MAX_CHARS = 20_000;
/** Upper bound for caller-supplied text, keeping tokenization and scoring cost bounded. */
export const MAX_INPUT_TEXT_CHARS = 200_000;

export const scrapePageInputSchema = z.object({
  url: urlField(),
  forceHeadless: z
    .boolean()
    .default(false)
    .describe("Force Playwright render instead of plain HTTP fetch"),
  maxChars: z
    .number()
    .int()
    .min(500)
    .max(100_000)
    .default(DEFAULT_SCRAPE_MAX_CHARS)
    .describe("Maximum bodyText characters to return (response sets truncated=true when cut)"),
});

export const extractKeywordsInputSchema = z
  .object({
    url: urlField("Page URL to scrape for keyword extraction (provide url or text, not both)").optional(),
    text: z
      .string()
      .min(20)
      .max(MAX_INPUT_TEXT_CHARS)
      .optional()
      .describe("Raw text to analyze instead of a URL (provide url or text, not both)"),
    topK: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(15)
      .describe("Number of top keywords to return"),
  })
  .superRefine((v, ctx) => {
    if ((v.url === undefined) === (v.text === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Provide either url or text" });
    }
  });

export const contentGapInputSchema = z.object({
  yourContent: z
    .union([
      z.object({
        type: z.literal("url").describe("Fetch your content from a URL"),
        value: urlField("URL of your page"),
      }),
      z.object({
        type: z.literal("raw_text").describe("Use the supplied text as your content"),
        value: z.string().min(50).max(MAX_INPUT_TEXT_CHARS).describe("Your article text"),
      }),
    ])
    .describe("Your content as a URL or raw text"),
  competitorUrls: z
    .array(urlField("Competitor page URL"))
    .min(1)
    .max(10)
    .describe("Competitor page URLs (failed URLs return in errors, others still process)"),
});

export const compareHeadingsInputSchema = z.object({
  urls: z
    .array(urlField("Page URL whose heading outline to list"))
    .min(2)
    .max(10)
    .describe("URLs whose heading outlines to compare"),
});

export const readabilityInputSchema = z
  .object({
    url: urlField("Page URL to score (provide url or text, not both)").optional(),
    text: z
      .string()
      .min(50)
      .max(MAX_INPUT_TEXT_CHARS)
      .optional()
      .describe("Raw text to score (provide url or text, not both)"),
  })
  .superRefine((v, ctx) => {
    if ((v.url === undefined) === (v.text === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Provide either url or text" });
    }
  });

export const qualityInputSchema = z.object({
  url: urlField("Page URL to score for on-page content quality"),
});

export const serpFeaturesInputSchema = z.object({
  query: z.string().min(2).max(200).describe("Search query for SerpApi"),
  region: z
    .string()
    .min(2)
    .max(10)
    .optional()
    .describe("Google gl region code, e.g. us, in, uk"),
});

export const clusterCompetitorsInputSchema = z.object({
  urls: z
    .array(urlField("Competitor page URL"))
    .min(2)
    .max(20)
    .describe("Competitor URLs to cluster by content similarity"),
  k: z
    .number()
    .int()
    .min(2)
    .max(10)
    .default(3)
    .describe("Number of clusters (fewer are returned when pages are near-duplicates)"),
});

export type ContentGapInput = z.infer<typeof contentGapInputSchema>;
export type ScrapePageInput = z.infer<typeof scrapePageInputSchema>;
export type ExtractKeywordsInput = z.infer<typeof extractKeywordsInputSchema>;
export type CompareHeadingsInput = z.infer<typeof compareHeadingsInputSchema>;
export type ReadabilityInput = z.infer<typeof readabilityInputSchema>;
export type QualityInput = z.infer<typeof qualityInputSchema>;
export type SerpFeaturesInput = z.infer<typeof serpFeaturesInputSchema>;
export type ClusterCompetitorsInput = z.infer<typeof clusterCompetitorsInputSchema>;

export function zodToErrorMessage(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
}
