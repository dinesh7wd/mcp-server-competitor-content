import { z } from "zod";

export const urlSchema = z.string().url().refine((u) => u.startsWith("http://") || u.startsWith("https://"), {
  message: "Only http(s) URLs are allowed",
});

export const scrapePageInputSchema = z.object({
  url: urlSchema,
  forceHeadless: z.boolean().default(false),
});

export const extractKeywordsInputSchema = z.object({
  url: urlSchema.optional(),
  text: z.string().min(20).optional(),
  topK: z.number().int().min(1).max(50).default(15),
}).superRefine((v, ctx) => {
  if ((v.url === undefined) === (v.text === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Provide either url or text" });
  }
});

export const contentGapInputSchema = z.object({
  yourContent: z.union([
    z.object({ type: z.literal("url"), value: urlSchema }),
    z.object({ type: z.literal("raw_text"), value: z.string().min(50) }),
  ]),
  competitorUrls: z.array(urlSchema).min(1).max(10),
});

export const compareHeadingsInputSchema = z.object({
  urls: z.array(urlSchema).min(2).max(10),
});

export const readabilityInputSchema = z.object({
  url: urlSchema.optional(),
  text: z.string().min(50).optional(),
}).superRefine((v, ctx) => {
  if ((v.url === undefined) === (v.text === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Provide either url or text" });
  }
});

export const qualityInputSchema = z.object({
  url: urlSchema,
});

export const serpFeaturesInputSchema = z.object({
  query: z.string().min(2).max(200),
  region: z.string().min(2).max(10).optional(),
});

export const clusterCompetitorsInputSchema = z.object({
  urls: z.array(urlSchema).min(2).max(20),
  k: z.number().int().min(2).max(10).default(3),
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
