// netlify/functions/screen.js
//
// Server-side proxy to the Anthropic API.
// The API key lives ONLY here, as an environment variable on Netlify.
// The browser never sees it. The browser calls /.netlify/functions/screen
// with a { name, kind } body, and this function does the research call.

export default async (request) => {
  // Only allow POST
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json({ error: "Server is missing ANTHROPIC_API_KEY" }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }

  const name = (body.name || "").toString().trim();
  const kind = (body.kind || "entity or individual — infer which").toString();
  if (!name) {
    return json({ error: "Missing 'name'" }, 400);
  }

  const prompt = researchPrompt(name, kind);

  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4000,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await upstream.json();

    if (!upstream.ok) {
      return json(
        { error: "Upstream API error", detail: data?.error?.message || upstream.statusText },
        upstream.status
      );
    }

    // Pull the text out of the response, strip to JSON, and parse.
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    let jsonStr = text.trim();
    const a = jsonStr.indexOf("{");
    const b = jsonStr.lastIndexOf("}");
    if (a >= 0 && b > a) jsonStr = jsonStr.slice(a, b + 1);
    jsonStr = jsonStr.replace(/```json|```/g, "");

    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      return json({ error: "Could not parse research output", raw: text.slice(0, 800) }, 502);
    }

    return json(parsed, 200);
  } catch (e) {
    return json({ error: "Request failed", detail: String(e?.message || e) }, 500);
  }
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function researchPrompt(name, kind) {
  return `You are an AML/KYC research analyst performing adverse media and beneficial ownership screening for a Tier-1 bank's Corporate & Investment Banking unit.

SUBJECT TO SCREEN: "${name}" (treat as ${kind}).

Use web search to research the subject thoroughly. Then return ONLY a JSON object (no preamble, no markdown fences) with this exact shape:

{
  "subject": "resolved full name",
  "type": "Entity" | "Individual",
  "descriptor": "one short line: sector, country, listed/private, etc",
  "found": true | false,
  "parties": [
    {
      "name": "party name",
      "relationship": "Client entity | UBO (current) | Director (current) | Senior manager | Parent company | Former owner | Former director | Nominee holder | Non-controlling minority",
      "current": true | false,
      "ownership": "e.g. ~61.5% or null",
      "pep": true | false,
      "pep_detail": "role/position if PEP, else empty",
      "hits": [
        {
          "category": "one of: Terrorist financing, Sanctions breach or evasion, Money laundering, Bribery and corruption, Fraud, Organised crime links, Human trafficking / modern slavery, Drug or arms trafficking, Tax evasion, Market abuse / insider dealing, Cybercrime, Regulatory fine / enforcement, Antitrust / competition, Major litigation, Environmental / labour (ESG), Minor / legacy reputational",
          "proof": "one of: Conviction / admitted, Charged / formal enforcement, Under investigation (official), Allegation, corroborated, Allegation, single source",
          "recency": "one of: Live / under 1 year, 1 to 3 years, 3 to 5 years, 5 to 7 years, Over 7 years",
          "source": "one of: Tier 1, multiple, Tier 1, single, Tier 2, corroborated, Tier 2, single, Tier 3, local/specialist, Tier 4, unverified",
          "summary": "1-2 sentence factual description of the adverse media finding"
        }
      ]
    }
  ],
  "notes": "short analyst note on ownership tracing confidence and any gaps"
}

RULES:
- ALWAYS include the subject itself as the first party (relationship "Client entity" or, for an individual, "UBO (current)").
- Trace beneficial ownership: include parent companies, ultimate beneficial owners (real people where known), directors and senior managers. For listed companies with dispersed ownership, name the controlling shareholder/family or state control sits with the public float.
- Flag PEP status (Politically Exposed Person) on any individual who holds or held public office, or close associates/family of such.
- Only include hits backed by real findings. If a party is clean, use "hits": [].
- If you genuinely cannot find the subject, set "found": false and return just the subject as a single clean party.
- Be accurate and conservative. Do not invent adverse media. Map each finding honestly to proof level, recency and source tier.
- Return ONLY the JSON object.`;
}
