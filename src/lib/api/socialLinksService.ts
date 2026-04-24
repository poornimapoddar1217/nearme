type SocialSource =
  | "website-scraper"
  | "search-scraper"
  | "fallback-search";

export type SocialLinksResult = {
  linkedin: string;
  instagram: string;
  source: SocialSource;
  linkedinConfidence: number;
  instagramConfidence: number;
};

function cleanUrl(url: string): string {
  return url.replace(/&amp;/g, "&").replace(/[)"'>\s].*$/g, "").trim();
}

function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function extractHrefCandidates(html: string): string[] {
  const hrefs = [...html.matchAll(/href=["']([^"']+)["']/gi)]
    .map((match) => match[1] ?? "")
    .filter(Boolean);

  return hrefs.map((href) => {
    const cleaned = cleanUrl(href);
    const qMatch = cleaned.match(/[?&]q=([^&]+)/i);
    if (qMatch?.[1]) return decodeSafe(qMatch[1]);
    const uddgMatch = cleaned.match(/[?&]uddg=([^&]+)/i);
    if (uddgMatch?.[1]) return decodeSafe(uddgMatch[1]);
    return cleaned;
  });
}

function decodeCandidates(html: string): string[] {
  const matches = [...html.matchAll(/uddg=([^"&\s]+)/g)];
  return matches
    .map((match) => decodeSafe(match[1] ?? ""))
    .filter(Boolean);
}

function firstMatchingUrl(candidates: string[], pattern: RegExp): string | undefined {
  for (const candidate of candidates) {
    const normalized = cleanUrl(candidate);
    if (pattern.test(normalized)) return normalized;
  }
  return undefined;
}

function normalizeLinkedInUrl(url: string): string {
  const cleaned = cleanUrl(url);
  try {
    const parsed = new URL(cleaned);
    if (!/linkedin\.com$/i.test(parsed.hostname.replace(/^www\./i, ""))) return cleaned;
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.protocol}//${parsed.hostname}${path}`;
  } catch {
    return cleaned;
  }
}

function normalizeInstagramUrl(url: string): string {
  const cleaned = cleanUrl(url);
  try {
    const parsed = new URL(cleaned);
    if (!/instagram\.com$/i.test(parsed.hostname.replace(/^www\./i, ""))) return cleaned;
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.protocol}//${parsed.hostname}${path}`;
  } catch {
    return cleaned;
  }
}

function isValidLinkedInCompanyUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, "");
    if (!/linkedin\.com$/i.test(host)) return false;
    return /^\/company\/[A-Za-z0-9._%-]+\/?$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function isValidInstagramProfileUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, "");
    if (!/instagram\.com$/i.test(host)) return false;
    if (/^\/(explore|reel|p|stories|accounts)\b/i.test(parsed.pathname)) return false;
    return /^\/[A-Za-z0-9._%-]+\/?$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function compactQueryText(value: string): string {
  return value
    .replace(/[|/\\]+/g, " ")
    .replace(/\b(ground floor|first floor|second floor|near|opp|opposite)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pickAddressHint(address: string): string {
  const cleaned = compactQueryText(address);
  if (!cleaned) return "";
  const parts = cleaned.split(",").map((part) => part.trim()).filter(Boolean);
  // Use only first short address segment to avoid over-constraining search.
  return (parts[0] ?? cleaned).slice(0, 40).trim();
}

function buildGoogleFallbacks(name: string, address: string): { linkedin: string; instagram: string } {
  const cleanName = compactQueryText(name);
  const addressHint = pickAddressHint(address);
  const linkedinQuery = [cleanName, addressHint, "site:linkedin.com/company"]
    .filter(Boolean)
    .join(" ");
  const instagramQuery = [cleanName, addressHint, "instagram"]
    .filter(Boolean)
    .join(" ");
  return {
    linkedin: `https://www.google.com/search?q=${encodeURIComponent(linkedinQuery)}`,
    instagram: `https://www.google.com/search?q=${encodeURIComponent(instagramQuery)}`,
  };
}

function firstLinkedInCompanyUrl(candidates: string[]): string | undefined {
  const company = firstMatchingUrl(
    candidates,
    /https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/company\/[A-Za-z0-9._%-]+\/?/i
  );
  if (company) return normalizeLinkedInUrl(company);
  const generic = firstMatchingUrl(
    candidates,
    /https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/(company|in|school|showcase|posts)\/?/i
  );
  return generic ? normalizeLinkedInUrl(generic) : undefined;
}

function extractSocialLinksFromJsonLd(html: string): { linkedin?: string; instagram?: string } {
  const scripts = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const candidates: string[] = [];
  for (const script of scripts) {
    const raw = script[1]?.trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      const crawl = (value: unknown) => {
        if (!value) return;
        if (typeof value === "string") {
          candidates.push(value);
          return;
        }
        if (Array.isArray(value)) {
          value.forEach(crawl);
          return;
        }
        if (typeof value === "object") {
          for (const nested of Object.values(value)) crawl(nested);
        }
      };
      crawl(parsed);
    } catch {
      continue;
    }
  }

  const linkedin = firstMatchingUrl(
    candidates,
    /https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/(company|in|school|showcase|posts)\/?/i
  );
  const instagram = firstMatchingUrl(
    candidates,
    /https?:\/\/(www\.)?instagram\.com\/[A-Za-z0-9._%-]+\/?/i
  );
  return {
    linkedin: linkedin ? normalizeLinkedInUrl(linkedin) : undefined,
    instagram: instagram ? normalizeInstagramUrl(instagram) : undefined,
  };
}

async function scrapeLinksFromWebsite(url: string): Promise<{ linkedin?: string; instagram?: string }> {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/i.test(parsed.protocol)) return {};
  } catch {
    return {};
  }

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "near-me-app/1.0 (+social-links-website-scraper)",
      },
      cache: "no-store",
    });
    if (!response.ok) return {};
    const html = await response.text();
    const jsonLd = extractSocialLinksFromJsonLd(html);

    const inlineLinks = [...html.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((m) => m[0] ?? "");
    const hrefLinks = extractHrefCandidates(html);
    const candidates = [...inlineLinks, ...hrefLinks];

    const linkedin =
      jsonLd.linkedin ??
      firstMatchingUrl(
        candidates,
        /https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/(company|in|school|showcase|posts)\/?/i
      );
    const instagram =
      jsonLd.instagram ??
      firstMatchingUrl(candidates, /https?:\/\/(www\.)?instagram\.com\/[A-Za-z0-9._%-]+\/?/i);

    return {
      linkedin: linkedin ? normalizeLinkedInUrl(linkedin) : undefined,
      instagram: instagram ? normalizeInstagramUrl(instagram) : undefined,
    };
  } catch {
    return {};
  }
}

export async function resolveSocialLinks(params: {
  name: string;
  address: string;
  website?: string;
}): Promise<SocialLinksResult> {
  const name = params.name.trim();
  const address = params.address.trim();
  const website = params.website?.trim() ?? "";
  const fallback = buildGoogleFallbacks(name, address);

  const websiteSocial = website ? await scrapeLinksFromWebsite(website) : {};
  const websiteLinkedIn = websiteSocial.linkedin ? normalizeLinkedInUrl(websiteSocial.linkedin) : "";
  const websiteInstagram = websiteSocial.instagram
    ? normalizeInstagramUrl(websiteSocial.instagram)
    : "";
  const websiteLinkedInOk = websiteLinkedIn ? isValidLinkedInCompanyUrl(websiteLinkedIn) : false;
  const websiteInstagramOk = websiteInstagram
    ? isValidInstagramProfileUrl(websiteInstagram)
    : false;

  if (websiteLinkedInOk || websiteInstagramOk) {
    return {
      linkedin: websiteLinkedInOk ? websiteLinkedIn : fallback.linkedin,
      instagram: websiteInstagramOk ? websiteInstagram : fallback.instagram,
      source: "website-scraper",
      linkedinConfidence: clampConfidence(websiteLinkedInOk ? 0.95 : 0.2),
      instagramConfidence: clampConfidence(websiteInstagramOk ? 0.95 : 0.2),
    };
  }

  const query = `${name} ${address} linkedin instagram`.trim();
  const endpoint = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  try {
    const response = await fetch(endpoint, {
      headers: {
        "User-Agent": "near-me-app/1.0 (+social-links-scraper)",
      },
      cache: "no-store",
    });

    if (!response.ok) {
      return {
        ...fallback,
        source: "fallback-search",
        linkedinConfidence: 0.15,
        instagramConfidence: 0.15,
      };
    }

    const html = await response.text();
    const inlineLinks = [...html.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((m) => m[0] ?? "");
    const hrefLinks = extractHrefCandidates(html);
    const decodedLinks = decodeCandidates(html);
    const candidates = [...inlineLinks, ...hrefLinks, ...decodedLinks];

    const scrapedLinkedIn = firstLinkedInCompanyUrl(candidates);
    const scrapedInstagram = firstMatchingUrl(
      candidates,
      /https?:\/\/(www\.)?instagram\.com\/[A-Za-z0-9._%-]+\/?/i
    );

    const linkedInNormalized = scrapedLinkedIn ? normalizeLinkedInUrl(scrapedLinkedIn) : "";
    const instagramNormalized = scrapedInstagram ? normalizeInstagramUrl(scrapedInstagram) : "";
    const linkedInOk = linkedInNormalized ? isValidLinkedInCompanyUrl(linkedInNormalized) : false;
    const instagramOk = instagramNormalized ? isValidInstagramProfileUrl(instagramNormalized) : false;

    return {
      linkedin: linkedInOk ? linkedInNormalized : fallback.linkedin,
      instagram: instagramOk ? instagramNormalized : fallback.instagram,
      source: linkedInOk || instagramOk ? "search-scraper" : "fallback-search",
      linkedinConfidence: clampConfidence(linkedInOk ? 0.75 : 0.15),
      instagramConfidence: clampConfidence(instagramOk ? 0.72 : 0.15),
    };
  } catch {
    return {
      ...fallback,
      source: "fallback-search",
      linkedinConfidence: 0.15,
      instagramConfidence: 0.15,
    };
  }
}
