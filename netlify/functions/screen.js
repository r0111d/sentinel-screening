// netlify/functions/screen.js
//
// Gemini version, hardened JSON handling.
// Fixes "Could not parse research output" by (1) stripping grounding noise,
// (2) extracting the largest valid JSON object even when wrapped in prose or
// markdown, and (3) a single repair retry that asks the model to reformat to
// pure JSON if the first pass can't be parsed.
//
// Key lives only here as env var GEMINI_API_KEY. Browser never sees it.

const MODEL = "gemini-2.5-flash";
const ENDPOINT = (key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`;

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

  try {
    // ---- Pass 1: research with Google Search grounding ----
    const text1 = await callGemini(apiKey, {
      contents: [{ role: "user", parts: [{ text: researchPrompt(name, kind) }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 4000 },
    });

    let parsed = tryExtractJson(text1);
    if (parsed) return json(parsed, 200);

    // ---- Pass 2: repair. Ask the model to reformat its own output to pure JSON.
    if (text1 && text1.trim().length) {
      const text2 = await callGemini(apiKey, {
        contents: [{
          role: "user",
          parts: [{
            text:
              "Convert the following analyst notes into a SINGLE valid JSON object only. " +
              "No markdown, no commentary, no code fences. If a value is unknown use null or an empty array. " +
              "Keep this exact schema: {subject, type, descriptor, found, parties:[{name, relationship, current, ownership, pep, pep_detail, hits:[{category, proof, recency, source, summary}]}], notes}.\n\n" +
              "NOTES:\n" + text1,
          }],
        }],
        generationConfig: { temperature: 0, maxOutputTokens: 4000, responseMimeType: "application/json" },
      });
      parsed = tryExtractJson(text2);
      if (parsed) return json(parsed, 200);

      return json({ error: "Could not parse research output", raw: text1.slice(0, 1200) }, 502);
    }

    return json({ error: "Empty response from model" }, 502);
  } catch (e) {
    return json({ error: "Request failed", detail: String(e?.message || e) }, 500);
  }
};

async function callGemini(apiKey, payload) {
  const r = await fetch(ENDPOINT(apiKey), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!r.ok) {
    throw new Error(data?.error?.message || `Gemini HTTP ${r.status}`);
  }
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p.text || "").join("\n");
}

function tryExtractJson(text) {
  if (!text) return null;
  let t = text.trim();
  t = t.replace(/```json/gi, "```").replace(/```/g, "").trim();
  const direct = safeParse(t);
  if (direct) return direct;
  const block = largestJsonObject(t);
  if (block) {
    const p = safeParse(block);
    if (p) return p;
    const cleaned = block
      .replace(/,\s*([}\]])/g, "$1")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2018\u2019]/g, "'");
    const p2 = safeParse(cleaned);
    if (p2) return p2;
  }
  return null;
}

function safeParse(s) {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : null;
  } catch { return null; }
}

function largestJsonObject(s) {
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function researchPrompt(name, kind) {
  return `You are an AML/KYC research analyst performing adverse media and beneficial ownership screening for a Tier-1 bank's Corporate & Investment Banking unit.

SUBJECT TO SCREEN: "${name}" (treat as ${kind}).

Use Google Search to research the subject thoroughly. Then output ONLY a single JSON object. Do not write any sentence before or after it. Do not use markdown code fences. The JSON must match this exact shape:

{
  "subject": "resolved full name",
  "type": "Entity",
  "descriptor": "one short line: sector, country, listed/private, etc",
  "found": true,
  "parties": [
    {
      "name": "party name",
      "relationship": "Client entity | UBO (current) | Director (current) | Senior manager | Parent company | Former owner | Former director | Nominee holder | Non-controlling minority",
      "current": true,
      "ownership": "e.g. ~61.5% or null",
      "pep": false,
      "pep_detail": "",
      "hits": [
        {
          "category": "one of: Terrorist financing, Sanctions breach or evasion, Money laundering, Bribery and corruption, Fraud, Organised crime links, Human trafficking / modern slavery, Drug or arms trafficking, Tax evasion, Market abuse / insider dealing, Cybercrime, Regulatory fine / enforcement, Antitrust / competition, Major litigation, Environmental / labour (ESG), Minor / legacy reputational",
          "proof": "one of: Conviction / admitted, Charged / formal enforcement, Under investigation (official), Allegation, corroborated, Allegation, single source",
          "recency": "one of: Live / under 1 year, 1 to 3 years, 3 to 5 years, 5 to 7 years, Over 7 years",
          "source": "one of: Tier 1, multiple, Tier 1, single, Tier 2, corroborated, Tier 2, single, Tier 3, local/specialist, Tier 4, unverified",
          "summary": "1-2 sentence factual description"
        }
      ]
    }
  ],
  "notes": "short analyst note on ownership tracing confidence and gaps"
}

RULES:
- ALWAYS include the subject itself as the first party (relationship "Client entity", or "UBO (current)" for an individual).
- Trace beneficial ownership: parent companies, ultimate beneficial owners (real people where known), directors and senior managers. For listed companies with dispersed ownership, name the controlling shareholder/family or say control sits with the public float.
- Flag PEP status on any individual holding or having held public office, or their close associates/family.
- Only include hits backed by real findings. If a party is clean, use "hits": [].
- If you cannot find the subject, set "found": false and return just the subject as one clean party.
- Be accurate and conservative. Do not invent adverse media.
- Output the JSON object and nothing else.`;
}
