import { NextRequest, NextResponse } from "next/server";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";

type CompetitorRow = {
  name: string;
  address: string;
  distanceMeters: number;
  rating?: number;
};

type AgentRequest = {
  companyName?: string;
  companyCategory?: string;
  companyServices?: string;
  companyLocation?: string;
  question?: string;
  competitors?: CompetitorRow[];
};

function userSafeAiReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : "Unknown agent error.";
  const lower = raw.toLowerCase();
  if (
    lower.includes("quota") ||
    lower.includes("rate limit") ||
    lower.includes("billing") ||
    lower.includes("insufficient_quota")
  ) {
    return "AI agent is temporarily unavailable due to usage limits. Showing fallback answer.";
  }
  if (
    lower.includes("api key") ||
    lower.includes("authentication") ||
    lower.includes("unauthorized")
  ) {
    return "AI agent is currently unavailable due to configuration. Showing fallback answer.";
  }
  return "AI agent is currently unavailable. Showing fallback answer.";
}

function fallbackAnswer(body: AgentRequest): string {
  const question = body.question?.trim() || "How can I improve against competitors?";
  const rows = (body.competitors ?? []).slice(0, 5);
  const nearest = [...rows].sort((a, b) => a.distanceMeters - b.distanceMeters)[0];
  const topRated = [...rows]
    .filter((item) => typeof item.rating === "number")
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))[0];

  return [
    `Question: ${question}`,
    "",
    "Practical answer:",
    nearest
      ? `- Start with hyper-local positioning around ${nearest.name} (nearest competitor) using localized keywords and fast response SLA.`
      : "- Start with hyper-local positioning in your target area using localized keywords and fast response SLA.",
    topRated
      ? `- Benchmark quality against ${topRated.name} (highest visible rating) and improve reviews/reputation strategy weekly.`
      : "- Benchmark quality against top visible competitors and improve reviews/reputation strategy weekly.",
    "- Publish proof-based content (case studies, before/after, measurable outcomes) 3 times weekly.",
    "- Track top 3 competitors weekly for ratings, offers, and service messaging; adapt pricing/packaging accordingly.",
  ].join("\n");
}

export async function POST(request: NextRequest) {
  let body: AgentRequest = {};
  try {
    body = (await request.json()) as AgentRequest;
    const question = body.question?.trim();
    if (!question) {
      return NextResponse.json({ error: "question is required." }, { status: 400 });
    }

    const openRouterKey = process.env.OPENROUTER_API_KEY;
    const openAiKey = process.env.OPENAI_API_KEY;
    const rawKey = openRouterKey ?? openAiKey;
    const isOpenRouter = !!rawKey?.startsWith("sk-or-v1");
    if (!rawKey) {
      return NextResponse.json({
        answer: fallbackAnswer(body),
        source: "fallback",
        reason: "AI agent is currently unavailable due to configuration. Showing fallback answer.",
      });
    }

    const openai = createOpenAI({
      apiKey: rawKey,
      ...(isOpenRouter && { baseURL: "https://openrouter.ai/api/v1" }),
    });
    const modelId = isOpenRouter ? "openai/gpt-4o-mini" : "gpt-4o-mini";
    const competitors = (body.competitors ?? []).slice(0, 8);
    const { text } = await generateText({
      model: openai(modelId),
      temperature: 0.3,
      prompt: `You are an expert local competitor strategy agent.
Answer the user's question with concise, actionable recommendations.
Use bullet points and keep it practical.

Company:
- Name: ${body.companyName ?? "N/A"}
- Category: ${body.companyCategory ?? "N/A"}
- Services: ${body.companyServices ?? "N/A"}
- Location: ${body.companyLocation ?? "N/A"}

Competitors JSON:
${JSON.stringify(competitors, null, 2)}

User question:
${question}
`,
    });

    return NextResponse.json({ answer: text, source: "ai", reason: null });
  } catch (error) {
    console.error("[competitor-agent] AI generation failed:", error);
    return NextResponse.json({
      answer: fallbackAnswer(body),
      source: "fallback",
      reason: userSafeAiReason(error),
    });
  }
}

