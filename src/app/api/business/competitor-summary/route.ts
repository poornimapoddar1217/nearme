import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

type CompetitorInput = {
  name: string;
  address: string;
  distanceMeters: number;
  rating?: number;
  website?: string;
};

type EnrichedCompetitor = CompetitorInput & { websiteSnippet: string };

type SummaryRequest = {
  companyName?: string;
  companyCategory?: string;
  companyServices?: string;
  companyLocation?: string;
  competitors?: CompetitorInput[];
};

function userSafeAiReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : "Unknown AI SDK error.";
  const lower = raw.toLowerCase();
  if (
    lower.includes("quota") ||
    lower.includes("rate limit") ||
    lower.includes("billing") ||
    lower.includes("insufficient_quota")
  ) {
    return "AI summary is temporarily unavailable due to usage limits. Showing fallback summary.";
  }
  if (
    lower.includes("api key") ||
    lower.includes("authentication") ||
    lower.includes("unauthorized")
  ) {
    return "AI summary is currently unavailable due to configuration. Showing fallback summary.";
  }
  return "AI summary is currently unavailable. Showing fallback summary.";
}

function fallbackSummary(body: SummaryRequest): string {
  const companyName = body.companyName?.trim() || "Your company";
  const competitors = (body.competitors ?? []).slice(0, 5);
  if (competitors.length === 0) {
    return "No competitor rows available yet. Run a search first to generate an AI-style summary.";
  }

  const rated = competitors.filter((item) => typeof item.rating === "number");
  const avgRating =
    rated.length > 0
      ? rated.reduce((acc, item) => acc + (item.rating ?? 0), 0) / rated.length
      : null;
  const nearest = [...competitors].sort((a, b) => a.distanceMeters - b.distanceMeters)[0];
  const highest = rated.length > 0 ? [...rated].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))[0] : null;

  const strengths = [
    "Local visibility is strong enough to surface several competitors in your immediate area.",
    highest ? `Benchmark target exists: ${highest.name} has the highest visible rating.` : "Competitor rating data is limited but still usable for benchmarking.",
  ];
  const weaknesses = [
    avgRating && avgRating >= 4.4
      ? "Competitor ratings are high on average, so trust signals and review responses need to be stronger."
      : "Rating advantage can still be captured by improving service quality and review collection.",
    nearest ? `Nearest competitor (${nearest.name}) is very close, increasing price and service comparison pressure.` : "Proximity pressure exists but needs better mapping depth.",
  ];

  return [
    `## Competitor Summary`,
    `- Focus company: ${companyName}`,
    nearest ? `- Nearest competitor: ${nearest.name}` : "",
    avgRating ? `- Average competitor rating: ${avgRating.toFixed(2)}` : "- Average competitor rating: N/A",
    "",
    `## Strengths`,
    ...strengths.map((s) => `- ${s}`),
    "",
    `## Weaknesses`,
    ...weaknesses.map((w) => `- ${w}`),
  ]
    .filter(Boolean)
    .join("\n");
}

async function fetchWebsiteSnippet(url: string): Promise<string> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const response = await fetch(url, {
      headers: { "User-Agent": "near-me-app/1.0 (+business-report)" },
      cache: "no-store",
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    if (!response.ok) return "";
    const html = await response.text();
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 600);
  } catch {
    return "";
  }
}

async function enrichCompetitors(competitors: CompetitorInput[]): Promise<EnrichedCompetitor[]> {
  return Promise.all(
    competitors.map(async (c) => ({
      ...c,
      websiteSnippet: c.website ? await fetchWebsiteSnippet(c.website) : "",
    }))
  );
}

export async function POST(request: NextRequest) {
  let parsedBody: SummaryRequest = {};
  try {
    const body = (await request.json()) as SummaryRequest;
    parsedBody = body;
    const competitors = (body.competitors ?? []).slice(0, 8);
    if (competitors.length === 0) {
      return NextResponse.json({ markdown: fallbackSummary(body), source: "fallback" });
    }

    const enriched = await enrichCompetitors(competitors);

    const openRouterKey = process.env.OPENROUTER_API_KEY;
    const openAiKey = process.env.OPENAI_API_KEY;
    // An OpenRouter key (sk-or-v1...) sent to api.openai.com returns 401.
    // Prefer an explicit OPENROUTER_API_KEY; fall back to OPENAI_API_KEY but
    // detect the key prefix so we always hit the right base URL.
    const rawKey = openRouterKey ?? openAiKey;
    const isOpenRouter = !!rawKey?.startsWith("sk-or-v1");
    if (!rawKey) {
      return NextResponse.json({
        markdown: fallbackSummary(body),
        source: "fallback",
        reason: "AI summary is currently unavailable due to configuration. Showing fallback summary.",
      });
    }

    const openai = createOpenAI({
      apiKey: rawKey,
      ...(isOpenRouter && { baseURL: "https://openrouter.ai/api/v1" }),
    });
    const modelId = isOpenRouter ? "openai/gpt-4o-mini" : "gpt-4o-mini";
    const { text } = await generateText({
      model: openai(modelId),
      temperature: 0.2,
      prompt: `You are a local business competitor analyst.
Generate concise markdown with exactly these sections:
1) ## Competitor Summary
2) ## Strengths
3) ## Weaknesses

Context:
- Company Name: ${body.companyName ?? "N/A"}
- Company Category: ${body.companyCategory ?? "N/A"}
- Company Services: ${body.companyServices ?? "N/A"}
- Company Location: ${body.companyLocation ?? "N/A"}

Top competitors (with website content where available):
${JSON.stringify(
  enriched.map((c) => ({
    name: c.name,
    address: c.address,
    distanceMeters: c.distanceMeters,
    rating: c.rating,
    website: c.website ?? null,
    websiteSnippet: c.websiteSnippet || null,
  })),
  null,
  2
)}

Rules:
- Keep it practical and short.
- Mention nearest and top-rated competitor where possible.
- Use websiteSnippet content (if present) to identify each competitor's actual services and positioning.
- Strengths and Weaknesses must be relative to the company profile and competitor list.`,
    });

    return NextResponse.json({ markdown: text, source: "ai", reason: null });
  } catch (error) {
    console.error("[competitor-summary] AI generation failed:", error);
    return NextResponse.json(
      {
        markdown: fallbackSummary(parsedBody),
        source: "fallback",
        reason: userSafeAiReason(error),
      },
      { status: 200 }
    );
  }
}

