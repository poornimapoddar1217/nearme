import { NextRequest, NextResponse } from "next/server";
import { ApifyClient } from "apify-client";

type BusinessReportRequest = {
  businessName?: string;
  businessPhone?: string;
  businessLocation?: string;
  businessPincode?: string;
  businessCategory?: string;
  businessServices?: string;
  reviewLink?: string;
  socialLink?: string;
};

type ScrapedPreview = {
  url: string;
  title: string;
  snippet: string;
  ok: boolean;
};

type ApifyDatasetItem = {
  title?: string;
  name?: string;
  description?: string;
  text?: string;
  snippet?: string;
  address?: string;
  reviews?: Array<{ text?: string; reviewText?: string; comment?: string }>;
};

const APIFY_TOKEN = process.env.APIFY_TOKEN;
const APIFY_REVIEW_ACTOR_ID = process.env.APIFY_REVIEW_ACTOR_ID;
const APIFY_SOCIAL_ACTOR_ID = process.env.APIFY_SOCIAL_ACTOR_ID;
const APIFY_INSTAGRAM_ACTOR_ID = process.env.APIFY_INSTAGRAM_ACTOR_ID ?? "apify/instagram-scraper";
const APIFY_LINKEDIN_ACTOR_ID = process.env.APIFY_LINKEDIN_ACTOR_ID ?? "dev_fusion/Linkedin-Profile-Scraper";

function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeHttpUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[\w.-]+\.[a-z]{2,}/i.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

function stripHtml(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(value: string, max = 280): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function extractTextFromApifyItem(item: ApifyDatasetItem): string {
  const reviewTexts =
    item.reviews
      ?.map((entry) => entry.text ?? entry.reviewText ?? entry.comment ?? "")
      .filter(Boolean)
      .join(" ") ?? "";

  const combined = [item.description, item.text, item.snippet, item.address, reviewTexts]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return combined;
}

type Platform = "instagram" | "linkedin" | "google_maps" | "generic";

function detectPlatform(url: string): Platform {
  const host = new URL(url).hostname.toLowerCase();
  if (host.includes("instagram.com")) return "instagram";
  if (host.includes("linkedin.com")) return "linkedin";
  if (host.includes("google.com/maps") || host.includes("maps.google") || host.includes("goo.gl")) return "google_maps";
  return "generic";
}

function buildActorInput(url: string, platform: Platform): Record<string, unknown> {
  switch (platform) {
    case "instagram":
      // apify/instagram-scraper input schema
      return { directUrls: [url], resultsType: "details", resultsLimit: 10 };
    case "linkedin":
      // dev_fusion/Linkedin-Profile-Scraper input schema
      return { profileUrls: [url] };
    case "google_maps":
      // compass/crawler-google-places input schema
      return { startUrls: [{ url }] };
    default:
      return { startUrls: [{ url }], maxItems: 20 };
  }
}

function resolveActorForUrl(url: string, fallbackActorId: string): { actorId: string; input: Record<string, unknown> } {
  const platform = detectPlatform(url);
  console.log(`[apify] platform detected: ${platform} for ${url}`);
  switch (platform) {
    case "instagram":
      return { actorId: APIFY_INSTAGRAM_ACTOR_ID, input: buildActorInput(url, "instagram") };
    case "linkedin":
      return { actorId: APIFY_LINKEDIN_ACTOR_ID, input: buildActorInput(url, "linkedin") };
    default:
      return { actorId: fallbackActorId, input: buildActorInput(url, platform) };
  }
}

async function runActor(
  client: ApifyClient,
  actorId: string,
  input: Record<string, unknown>
): Promise<{ defaultDatasetId?: string } | null> {
  try {
    console.log(`[apify] calling actor=${actorId} input=${JSON.stringify(input)}`);
    const run = await client.actor(actorId).call(input);
    console.log(`[apify] run result: id=${run?.id} status=${run?.status} datasetId=${run?.defaultDatasetId ?? "none"}`);
    if (run?.defaultDatasetId) return run;
  } catch (err) {
    console.warn(`[apify] actor=${actorId} threw:`, err);
  }
  return null;
}

function pickBestTitle(items: ApifyDatasetItem[], url: string): string {
  for (const item of items) {
    const candidate = (item.title ?? item.name ?? "").trim();
    if (candidate) return candidate;
  }
  return new URL(url).hostname;
}

function buildMergedSnippet(items: ApifyDatasetItem[]): string {
  const snippets = items
    .slice(0, 5)
    .map((item) => extractTextFromApifyItem(item))
    .filter(Boolean);
  if (snippets.length === 0) return "";
  return truncate(snippets.join(" "));
}

async function scrapeWithApify(url: string, fallbackActorId: string): Promise<ScrapedPreview | null> {
  console.log("[apify-report] START", JSON.stringify({ fallbackActorId, url, hasToken: !!APIFY_TOKEN }));
  if (!APIFY_TOKEN || !isValidHttpUrl(url)) {
    console.log("[apify-report] SKIPPED", JSON.stringify({ hasToken: !!APIFY_TOKEN, validUrl: isValidHttpUrl(url) }));
    return null;
  }

  try {
    const client = new ApifyClient({ token: APIFY_TOKEN });
    const { actorId, input } = resolveActorForUrl(url, fallbackActorId);
    const run = await runActor(client, actorId, input);

    console.log("[apify-report] RUN RESULT", JSON.stringify({ datasetId: run?.defaultDatasetId ?? null }));
    const datasetId = run?.defaultDatasetId;
    // Return null so the caller's ?? fallback (scrapePreview) can take over.
    if (!datasetId) return null;

    const data = await client.dataset(datasetId).listItems();
    const items = (data.items ?? []) as ApifyDatasetItem[];
    console.log("[apify-report] RAW ITEMS (" + items.length + "):", JSON.stringify(items, null, 2));
    if (items.length === 0) {
      return {
        url,
        title: "Apify returned no items",
        snippet: "",
        ok: false,
      };
    }

    const title = pickBestTitle(items, url);
    const snippet = buildMergedSnippet(items);

    return {
      url,
      title: title || new URL(url).hostname,
      snippet,
      ok: snippet.length > 0 || Boolean(title),
    };
  } catch {
    return {
      url,
      title: "Apify scrape failed",
      snippet: "",
      ok: false,
    };
  }
}

async function scrapePreview(url: string): Promise<ScrapedPreview> {
  if (!isValidHttpUrl(url)) {
    return { url, title: "Invalid URL", snippet: "", ok: false };
  }

  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: {
        "User-Agent": "near-me-app/1.0 (+business-report)",
      },
    });
    if (!response.ok) {
      return {
        url,
        title: `Fetch failed (${response.status})`,
        snippet: "",
        ok: false,
      };
    }
    const html = await response.text();
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch?.[1]?.replace(/\s+/g, " ").trim() || new URL(url).hostname;
    const text = stripHtml(html);
    return {
      url,
      title,
      snippet: text.slice(0, 280),
      ok: true,
    };
  } catch {
    return {
      url,
      title: new URL(url).hostname,
      snippet: "",
      ok: false,
    };
  }
}

function buildHeuristicInsights(input: {
  businessName: string;
  businessLocation: string;
  reviewPreview?: ScrapedPreview;
  socialPreview?: ScrapedPreview;
}): string {
  const reviewSignal = input.reviewPreview?.ok
    ? "Review page accessible, customer feedback pipeline can be analyzed."
    : "Review page fetch failed; verify link or scraping permissions.";
  const socialSignal = input.socialPreview?.ok
    ? "Social profile accessible; content consistency can be tracked."
    : "Social link fetch failed or protected; use public profile URL.";

  return [
    `Business profile suggests ${input.businessName} operates around ${input.businessLocation}.`,
    reviewSignal,
    socialSignal,
    "Recommend weekly sentiment tracking, response-time SLA on reviews, and proof-based social posts.",
  ].join(" ");
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as BusinessReportRequest;
    const businessName = body.businessName?.trim() ?? "";
    const businessPhone = body.businessPhone?.trim() ?? "";
    const businessLocation = body.businessLocation?.trim() ?? "";
    const businessPincode = body.businessPincode?.trim() ?? "";
    const businessCategory = body.businessCategory?.trim() ?? "";
    const businessServices = body.businessServices?.trim() ?? "";
    const reviewLink = normalizeHttpUrl(body.reviewLink ?? "");
    const socialLink = normalizeHttpUrl(body.socialLink ?? "");

    if (!businessName || !businessPhone || !businessLocation) {
      return NextResponse.json(
        { error: "businessName, businessPhone and businessLocation are required." },
        { status: 400 }
      );
    }

    const reviewPreview = reviewLink
      ? (await scrapeWithApify(reviewLink, APIFY_REVIEW_ACTOR_ID ?? "")) ?? (await scrapePreview(reviewLink))
      : undefined;
    const socialPreview = socialLink
      ? (await scrapeWithApify(socialLink, APIFY_SOCIAL_ACTOR_ID ?? APIFY_REVIEW_ACTOR_ID ?? "")) ??
        (await scrapePreview(socialLink))
      : undefined;

    const insightText = buildHeuristicInsights({
      businessName,
      businessLocation,
      reviewPreview,
      socialPreview,
    });

    const markdown = [
      `## Business Report`,
      ``,
      `- **Company:** ${businessName}`,
      `- **Phone:** ${businessPhone}`,
      `- **Location:** ${businessLocation}`,
      businessPincode ? `- **Pincode:** ${businessPincode}` : "",
      businessCategory ? `- **Category:** ${businessCategory}` : "",
      businessServices ? `- **Services:** ${businessServices}` : "",
      reviewLink ? `- **Review link:** ${reviewLink}` : "",
      socialLink ? `- **Social media link:** ${socialLink}` : "",
      ``,
      `### Pipeline`,
      `- Validation: OK`,
      `- Scraper: ${reviewPreview?.ok || socialPreview?.ok ? "OK" : "Partial"}`,
      `- Data Cleaning: OK`,
      `- AI SDK Analysis: OK (local heuristic engine)`,
      `- Formatted Report: OK`,
      ``,
      `### Scraped Data`,
      reviewPreview
        ? `- **Review source:** ${reviewPreview.ok ? "Fetched" : "Not fetched"}`
        : "- **Review source:** Not provided",
      reviewPreview?.title ? `  - Title: ${reviewPreview.title}` : "",
      reviewPreview?.snippet ? `  - Snippet: ${reviewPreview.snippet}` : "",
      socialPreview
        ? `- **Social source:** ${socialPreview.ok ? "Fetched" : "Not fetched"}`
        : "- **Social source:** Not provided",
      socialPreview?.title ? `  - Title: ${socialPreview.title}` : "",
      socialPreview?.snippet ? `  - Snippet: ${socialPreview.snippet}` : "",
      ``,
      `### Insights`,
      `- ${insightText}`,
      ``,
      `### Improvements`,
      `- Google Reviews: Reply quickly, ask post-service review, resolve repeat complaints publicly.`,
      `- Social Media: Publish proof-based posts (case/result/team) 3x per week.`,
      `- Customer Trust: Keep profile details consistent across web, maps, and social.`,
    ].join("\n");

    return NextResponse.json({
      businessDetails: {
        name: businessName,
        phone: businessPhone,
        location: businessLocation,
        pincode: businessPincode || null,
        category: businessCategory || null,
        services: businessServices || null,
      },
      links: {
        reviewLink: reviewLink || null,
        socialLink: socialLink || null,
      },
      scraped: {
        reviewPreview: reviewPreview ?? null,
        socialPreview: socialPreview ?? null,
      },
      report: {
        markdown,
      },
      pipeline: {
        validation: "ok",
        scraper: reviewPreview?.ok || socialPreview?.ok ? "ok" : "partial",
        dataCleaning: "ok",
        aiSdkAnalysis: "ok",
        formattedReport: "ok",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to generate business report." },
      { status: 500 }
    );
  }
}
