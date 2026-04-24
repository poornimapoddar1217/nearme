import { NextRequest, NextResponse } from "next/server";
import { resolveSocialLinks } from "@/lib/api/socialLinksService";

export async function GET(request: NextRequest) {
  const name = request.nextUrl.searchParams.get("name")?.trim() ?? "";
  const address = request.nextUrl.searchParams.get("address")?.trim() ?? "";
  const website = request.nextUrl.searchParams.get("website")?.trim() ?? "";
  if (!name) {
    return NextResponse.json({ error: "name is required." }, { status: 400 });
  }

  try {
    const result = await resolveSocialLinks({ name, address, website });
    return NextResponse.json(result);
  } catch {
    const compactName = name.replace(/\s+/g, " ").trim();
    const compactAddressHint = (address.split(",")[0] ?? "").replace(/\s+/g, " ").trim();
    return NextResponse.json(
      {
        linkedin: `https://www.google.com/search?q=${encodeURIComponent(`${compactName} ${compactAddressHint} site:linkedin.com/company`)}`,
        instagram: `https://www.google.com/search?q=${encodeURIComponent(`${compactName} ${compactAddressHint} instagram`)}`,
        source: "fallback-search",
        linkedinConfidence: 0.15,
        instagramConfidence: 0.15,
      },
      { status: 200 }
    );
  }
}

