// netlify/functions/screen.js
//
// Gemini version. Server-side proxy to the Google Gemini API.
// The API key lives ONLY here, as an environment variable on Netlify
// (GEMINI_API_KEY). The browser never sees it. The browser calls
// /.netlify/functions/screen with { name, kind } and this function does
// the research call, with Google Search grounding turned on so it can
// look up real entities live.

export default async (request) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return json({ error: "Server is missing GEMINI_API_KEY" }, 500);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: "Invalid request body" }, 400); }

  const name = (body.name || "").toString().trim();
  const kind = (body.kind || "entity or individual — infer which").toString();
  if (!name) return json({ error: "Missing 'name'" }, 400);

  // Gemini model with a free tier that supports Google Search grounding.
  const model = "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const payload = {
    contents: [{ role: "user", parts: [{ text: researchPrompt(name, kind) }] }],
    // Turn on live web lookup. This is Gemini's equivalent of web search.
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 4000 },
  };

  try {
    const upstream = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await upstream.json();

    if (!upstream.ok) {
      return json(
        { error: "Upstream Gemini error", detail: data?.error?.message || upstream.statusText },
        upstream.status
      );
    }

    // Gemini returns candidates[].content.parts[].text
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const text = parts.map((p) => p.text || "").join("\n");

    let jsonStr = (text || "").trim();
    const a = jsonStr.indexOf("{");
    const b = jsonStr.lastIndexOf("}");
    if (a >= 0 && b > a) jsonStr = jsonStr.slice(a, b + 1);
    jsonStr = jsonStr.replace(/```json|```/g, "");

    let parsed;
    try { parsed = JSON.parse(jsonStr); }
    catch { return json({ error: "Could not parse research output", raw: (text || "").slice(0, 800) }, 502); }

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

Use Google Search to research the subject thoroughly. Then return ONLY a JSON object (no preamble, no markdown fences, no commentary before or after) with this exact shape:

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
- Your entire response must be the JSON object and nothing else.`;
}
