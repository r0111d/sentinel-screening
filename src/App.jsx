import React, { useState, useRef } from "react";

// ============================================================
// SCORING MATRIX  — exact weights from the uploaded workbook
// Final score = Category base x Proof x Recency x Source
// ============================================================
const CATEGORY_BASE = {
  "Terrorist financing": 10,
  "Sanctions breach or evasion": 10,
  "Money laundering": 10,
  "Bribery and corruption": 9,
  "Fraud": 8,
  "Organised crime links": 8,
  "Human trafficking / modern slavery": 8,
  "Drug or arms trafficking": 8,
  "Tax evasion": 7,
  "Market abuse / insider dealing": 7,
  "Cybercrime": 6,
  "Regulatory fine / enforcement": 6,
  "Antitrust / competition": 5,
  "Major litigation": 4,
  "Environmental / labour (ESG)": 4,
  "Minor / legacy reputational": 2,
};
const PROOF = {
  "Conviction / admitted": 1.0,
  "Charged / formal enforcement": 0.85,
  "Under investigation (official)": 0.7,
  "Allegation, corroborated": 0.55,
  "Allegation, single source": 0.35,
};
const RECENCY = {
  "Live / under 1 year": 1.0,
  "1 to 3 years": 0.85,
  "3 to 5 years": 0.7,
  "5 to 7 years": 0.5,
  "Over 7 years": 0.3,
};
const SOURCE = {
  "Tier 1, multiple": 1.0,
  "Tier 1, single": 0.9,
  "Tier 2, corroborated": 0.8,
  "Tier 2, single": 0.6,
  "Tier 3, local/specialist": 0.4,
  "Tier 4, unverified": 0.2,
};
function bandOf(s) {
  if (s >= 8) return { name: "Critical", hex: "#d14b48" };
  if (s >= 6) return { name: "High", hex: "#d2702e" };
  if (s >= 4) return { name: "Medium", hex: "#c9952f" };
  if (s >= 2) return { name: "Low-Medium", hex: "#a07d28" };
  return { name: "Low", hex: "#4a9b6e" };
}
function nearest(map, val, fallbackKey) {
  if (val == null) return fallbackKey;
  if (map[val] != null) return val;
  // tolerant match: case-insensitive contains
  const lv = String(val).toLowerCase();
  const k = Object.keys(map).find((x) => x.toLowerCase() === lv) ||
            Object.keys(map).find((x) => x.toLowerCase().includes(lv) || lv.includes(x.toLowerCase()));
  return k || fallbackKey;
}
function scoreHit(h) {
  const cat = nearest(CATEGORY_BASE, h.category, "Minor / legacy reputational");
  const pf = nearest(PROOF, h.proof, "Allegation, single source");
  const rc = nearest(RECENCY, h.recency, "Over 7 years");
  const sr = nearest(SOURCE, h.source, "Tier 4, unverified");
  const base = CATEGORY_BASE[cat], p = PROOF[pf], r = RECENCY[rc], s = SOURCE[sr];
  const raw = +(base * p * r * s).toFixed(2);
  return { cat, pf, rc, sr, base, p, r, s, raw, band: bandOf(raw) };
}
function inScope(rel, current) {
  if (current === false) return false;
  const r = (rel || "").toLowerCase();
  if (r.includes("former") || r.includes("nominee") || r.includes("non-controlling") ||
      r.includes("resigned") || r.includes("minority") || r.includes("ex-")) return false;
  return true;
}

// ============================================================
// LIVE RESEARCH  — calls Claude API with web search
// ============================================================
const RESEARCH_PROMPT = (name, kind) => `You are an AML/KYC research analyst performing adverse media and beneficial ownership screening for a Tier-1 bank's Corporate & Investment Banking unit.

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


  async function research(name, kind) {
    const resp = await fetch("/.netlify/functions/screen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, kind }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data?.error || data?.detail || "Screening request failed");
    }
    return data; // the function already returns parsed JSON in the right shape
  }


// ============================================================
// AGGREGATION  — model judgment layer
// ============================================================
function aggregate(parties) {
  let floor = 0, contained = 0, totalHits = 0, flagged = 0, peps = 0;
  parties.forEach((p) => {
    if (p.pep) peps++;
    let pFlag = false;
    (p.hits || []).forEach((h) => {
      const sc = scoreHit(h);
      h._sc = sc; totalHits++;
      if (sc.raw >= 4) pFlag = true;
      if (inScope(p.relationship, p.current)) { floor = Math.max(floor, sc.raw); h._effect = "floor"; }
      else { contained = Math.max(contained, sc.raw); h._effect = "contain"; }
    });
    if (pFlag) { flagged++; p._flag = true; }
  });
  let resolved = floor, edd = false, eddReason = "";
  if (contained >= 4 && floor < contained) {
    edd = true; resolved = Math.max(resolved, 1.4);
    eddReason = "A high-severity finding sits on a former or non-controlling party. It is contained: it does not set the client's risk floor, but it mandates Enhanced Due Diligence to confirm the party holds no current control and that the connection is severed.";
  }
  return {
    resolved: +resolved.toFixed(2), floor: +floor.toFixed(2), contained: +contained.toFixed(2),
    band: bandOf(resolved), totalHits, parties: parties.length, flagged, peps, edd, eddReason,
  };
}
function narrative(subject, parties, agg) {
  let dp = null, dh = null, ds = 0;
  parties.forEach((p) => (p.hits || []).forEach((h) => { if (h._sc && h._sc.raw > ds) { ds = h._sc.raw; dh = h; dp = p; } }));
  const pepNote = agg.peps ? ` ${agg.peps} PEP${agg.peps > 1 ? "s" : ""} identified in the structure, which raises the due-diligence bar.` : "";
  if (agg.band.name === "Critical" || agg.band.name === "High") {
    return {
      summary: `${subject} carries a live ${dh ? dh.category.toLowerCase() : "serious financial crime"} exposure on a current, in-scope party (${dp ? dp.name : "the subject"}), setting the risk floor at ${agg.resolved}.${pepNote} This cannot be cleared at first line and requires immediate escalation.`,
      action: ["ESCALATE — MLRO / COMPLIANCE", "#d14b48", "Escalate to Compliance and the MLRO now. Senior decision required on decline or exit, alongside any regulatory reporting obligation."],
    };
  }
  if (agg.edd && agg.floor < 4) {
    return {
      summary: `${subject} screens clean at the entity and current-control level. The severe ${dh ? dh.category.toLowerCase() : "exposure"} attaches to ${dp ? dp.name : "a former party"}, a former / non-controlling party, so it is contained and does not set the risk floor.${pepNote} Proceed only after EDD confirms the residual link carries no control.`,
      action: ["APPROVE w/ EDD CONDITIONS", "#c9952f", "Refer to Enhanced Due Diligence. Evidence the clean break and absence of current control, then clear with enhanced monitoring."],
    };
  }
  if (agg.band.name === "Medium") {
    return {
      summary: `${subject} shows a material finding on a current party warranting review before any decision. Score ${agg.resolved}.${pepNote}`,
      action: ["REFER TO EDD", "#c9952f", "Refer to Enhanced Due Diligence to gather more facts before deciding the relationship."],
    };
  }
  if (agg.band.name === "Low-Medium") {
    return {
      summary: `${subject} shows a low-to-medium finding, score ${agg.resolved}.${pepNote} Record with a senior analyst review; not decisive on its own.`,
      action: ["SENIOR ANALYST REVIEW", "#a07d28", "Record the finding with rationale and a senior review. Monitor."],
    };
  }
  return {
    summary: `${subject} screens clean across the ownership tree. No material adverse media on any current, in-scope party.${pepNote} Any residual items are low and recorded.`,
    action: ["APPROVE — STANDARD MONITORING", "#4a9b6e", "Clear for onboarding with standard periodic monitoring. Record the dispositions."],
  };
}

// ============================================================
// STYLES
// ============================================================
const C = {
  bg: "#0d1117", panel: "#161c27", panel2: "#1b222e", line: "#2a3340", line2: "#374252",
  ink: "#e8edf4", ink2: "#aeb9c7", ink3: "#6f7d8f", gold: "#c9a44c", gold2: "#e3c373",
  green: "#4a9b6e", red: "#c8483f", crit: "#d14b48", amber: "#c9952f", blue: "#5b8bbd",
};
const mono = "'IBM Plex Mono', ui-monospace, monospace";
const sans = "'IBM Plex Sans', system-ui, sans-serif";
const serif = "'Spectral', Georgia, serif";

const STEPS = [
  "Resolving the subject",
  "Tracing beneficial ownership (UBO)",
  "Running PEP screening",
  "Scanning adverse media across sources",
  "Scoring findings through the matrix",
  "Aggregating risk & drafting the report",
];

export default function App() {
  const [name, setName] = useState("");
  const [kind, setKind] = useState("auto");
  const [phase, setPhase] = useState("idle"); // idle | running | done | error
  const [stepIdx, setStepIdx] = useState(0);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [showReport, setShowReport] = useState(false);
  const reportRef = useRef(null);

  async function run() {
    if (!name.trim()) return;
    setPhase("running"); setStepIdx(0); setResult(null); setError("");
    // animate steps while the request runs
    let alive = true;
    const animate = async () => {
      for (let i = 0; i < STEPS.length - 1 && alive; i++) {
        setStepIdx(i);
        await new Promise((r) => setTimeout(r, 850 + Math.random() * 500));
      }
      if (alive) setStepIdx(STEPS.length - 1);
    };
    animate();
    try {
      const k = kind === "auto" ? "entity or individual — infer which" : kind;
      const data = await research(name.trim(), k);
      alive = false;
      const parties = (data.parties && data.parties.length ? data.parties : [{ name: data.subject || name, relationship: "Client entity", current: true, hits: [] }]);
      const agg = aggregate(parties);
      const narr = narrative(data.subject || name, parties, agg);
      setStepIdx(STEPS.length);
      setResult({ data, parties, agg, narr });
      setPhase("done");
    } catch (e) {
      alive = false;
      setError(String(e && e.message ? e.message : e));
      setPhase("error");
    }
  }

  function reset() { setPhase("idle"); setResult(null); setName(""); setError(""); }

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.ink, fontFamily: sans }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Spectral:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500&family=IBM+Plex+Sans:wght@300;400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes rise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
        @keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(209,75,72,0)}50%{box-shadow:0 0 0 4px rgba(209,75,72,.13)}}
        .acc{cursor:pointer}
        @media print{.noprint{display:none!important}.sheet{box-shadow:none!important}}
      `}</style>

      {/* top bar */}
      <div style={{ borderBottom: `1px solid ${C.line}`, position: "sticky", top: 0, background: "rgba(13,17,23,.8)", backdropFilter: "blur(10px)", zIndex: 20 }}>
        <div style={{ maxWidth: 1000, margin: "0 auto", padding: "0 22px", height: 60, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
            <Mark />
            <div>
              <div style={{ fontFamily: serif, fontWeight: 600, fontSize: 18 }}>Sentinel</div>
              <div style={{ fontFamily: mono, fontSize: 10, letterSpacing: ".09em", color: C.ink3, textTransform: "uppercase" }}>Live KYC Screening</div>
            </div>
          </div>
          <div style={{ fontFamily: mono, fontSize: 10.5, color: C.ink3, letterSpacing: ".05em" }}>UBO · PEP · ADVERSE MEDIA</div>
        </div>
      </div>

      <div style={{ maxWidth: 1000, margin: "0 auto", padding: "0 22px" }}>
        {/* hero / input */}
        {phase !== "done" && (
          <div style={{ padding: "54px 0 20px", textAlign: "center" }}>
            <div style={{ fontFamily: mono, fontSize: 11.5, letterSpacing: ".22em", textTransform: "uppercase", color: C.gold, marginBottom: 16 }}>
              Beneficial Ownership · PEP · Negative News · Scoring
            </div>
            <h1 style={{ fontFamily: serif, fontWeight: 600, fontSize: "clamp(28px,5vw,42px)", lineHeight: 1.1, margin: "0 0 12px" }}>
              Screen any client, <i style={{ color: C.gold2, fontWeight: 500 }}>live</i>.
            </h1>
            <p style={{ color: C.ink2, maxWidth: 580, margin: "0 auto 28px", fontSize: 15 }}>
              Type any company or person. Sentinel researches the beneficial ownership, screens every party for PEP status and adverse media in real time, scores each finding through your matrix, and produces a one-page report.
            </p>

            <div style={{ maxWidth: 620, margin: "0 auto" }}>
              <div style={{ display: "flex", gap: 10, background: C.panel, border: `1px solid ${C.line2}`, borderRadius: 13, padding: 7, paddingLeft: 16, alignItems: "center", boxShadow: "0 18px 50px -20px rgba(0,0,0,.7)" }}>
                <SearchIcon />
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && phase !== "running" && run()}
                  placeholder="e.g. a bank, a corporate, a fund, or a person's name"
                  style={{ flex: 1, background: "none", border: "none", outline: "none", color: C.ink, fontSize: 15.5, fontFamily: sans, padding: "10px 0" }}
                />
                <select value={kind} onChange={(e) => setKind(e.target.value)}
                  style={{ background: C.panel2, color: C.ink2, border: `1px solid ${C.line}`, borderRadius: 8, padding: "9px 10px", fontFamily: mono, fontSize: 12, outline: "none" }}>
                  <option value="auto">Auto</option>
                  <option value="entity">Entity</option>
                  <option value="individual">Individual</option>
                </select>
                <button onClick={run} disabled={phase === "running"}
                  style={{ background: phase === "running" ? C.line2 : `linear-gradient(170deg,${C.gold2},${C.gold})`, color: phase === "running" ? C.ink3 : "#1a1305", border: "none", fontWeight: 600, fontSize: 14, padding: "12px 20px", borderRadius: 9, cursor: phase === "running" ? "default" : "pointer", fontFamily: sans, whiteSpace: "nowrap" }}>
                  {phase === "running" ? "Screening…" : "Run screening"}
                </button>
              </div>

              <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap", marginTop: 16 }}>
                {["HSBC Holdings plc", "United Breweries Limited", "Glencore plc", "Wirecard AG"].map((x) => (
                  <span key={x} onClick={() => setName(x)}
                    style={{ fontSize: 12, color: C.ink2, background: C.panel, border: `1px solid ${C.line}`, borderRadius: 20, padding: "6px 13px", cursor: "pointer", fontFamily: mono }}>
                    {x}
                  </span>
                ))}
              </div>
            </div>

            <div style={{ maxWidth: 640, margin: "26px auto 0", fontSize: 11.5, color: C.ink3, lineHeight: 1.6, borderTop: `1px dashed ${C.line}`, paddingTop: 16 }}>
              This build performs <b style={{ color: C.ink2 }}>live research</b> using web search, so it works for any real name, not a fixed list. Findings are AI-assembled from public sources and must be verified by an analyst before any decision. For production, this same flow points at your licensed screening, PEP and registry providers.
            </div>
          </div>
        )}

        {/* progress */}
        {phase === "running" && (
          <div style={{ maxWidth: 540, margin: "10px auto 60px" }}>
            {STEPS.map((s, i) => {
              const done = i < stepIdx, on = i === stepIdx;
              return (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 13, padding: "12px 15px", border: `1px solid ${on || done ? C.line2 : C.line}`, borderRadius: 11, marginBottom: 8, background: C.panel, opacity: on || done ? 1 : 0.45, transition: "all .3s" }}>
                  <div style={{ width: 24, height: 24, borderRadius: "50%", border: `1.5px solid ${done ? C.green : on ? C.gold : C.line2}`, background: done ? C.green : "transparent", flex: "none", display: "grid", placeItems: "center", fontFamily: mono, fontSize: 11, color: done ? "#fff" : on ? C.gold : C.ink3 }}>
                    {done ? "✓" : on ? <span style={{ width: 12, height: 12, border: `2px solid ${C.line2}`, borderTopColor: C.gold, borderRadius: "50%", display: "inline-block", animation: "spin .7s linear infinite" }} /> : i + 1}
                  </div>
                  <div style={{ fontSize: 13.5, color: on || done ? C.ink : C.ink2 }}>{s}</div>
                </div>
              );
            })}
            <div style={{ textAlign: "center", marginTop: 14, fontFamily: mono, fontSize: 11, color: C.ink3 }}>
              Researching live · this can take 15–40 seconds
            </div>
          </div>
        )}

        {/* error */}
        {phase === "error" && (
          <div style={{ maxWidth: 600, margin: "20px auto 60px", background: "#2a1513", border: `1px solid ${C.red}`, borderRadius: 12, padding: 20 }}>
            <div style={{ fontFamily: mono, fontSize: 11, letterSpacing: ".1em", color: "#f0c0bd", textTransform: "uppercase", marginBottom: 8 }}>Screening could not complete</div>
            <div style={{ fontSize: 13.5, color: C.ink2, lineHeight: 1.55 }}>
              The live research call failed or returned an unexpected format. This can happen with rate limits or an ambiguous name. You can try again, or refine the name (add the country or full legal form).
            </div>
            <div style={{ fontFamily: mono, fontSize: 11, color: C.ink3, marginTop: 10, wordBreak: "break-word" }}>{error}</div>
            <button onClick={reset} style={btn(C)}>Try another name</button>
          </div>
        )}

        {/* RESULT */}
        {phase === "done" && result && (
          <Result C={C} result={result} onReset={reset} onReport={() => setShowReport(true)} />
        )}
      </div>

      <div style={{ borderTop: `1px solid ${C.line}`, textAlign: "center", padding: 20, color: C.ink3, fontSize: 11, fontFamily: mono, letterSpacing: ".04em" }}>
        SENTINEL · INTERNAL COMPLIANCE TOOL · AI-ASSISTED · NOT LEGAL OR INVESTMENT ADVICE · VERIFY BEFORE DECISION
      </div>

      {showReport && result && (
        <ReportModal C={C} result={result} onClose={() => setShowReport(false)} ref={reportRef} />
      )}
    </div>
  );
}

function btn(C) {
  return { marginTop: 14, background: C.panel, border: `1px solid ${C.line2}`, color: C.ink2, fontFamily: sans, fontSize: 13.5, padding: "10px 16px", borderRadius: 9, cursor: "pointer" };
}

// ============================================================
// RESULT VIEW
// ============================================================
function Result({ C, result, onReset, onReport }) {
  const { data, parties, agg, narr } = result;
  const [open, setOpen] = useState(() => parties.map((p) => (p.hits && p.hits.length ? true : false)));
  const isCrit = agg.band.name === "Critical" || agg.band.name === "High";
  const pct = Math.min(agg.resolved / 10, 1), circ = 2 * Math.PI * 52, off = circ * (1 - pct);

  return (
    <div style={{ padding: "16px 0 70px", animation: "rise .5s ease both" }}>
      {isCrit && (
        <div style={{ display: "flex", alignItems: "center", gap: 13, background: `linear-gradient(100deg,#2a1513,transparent)`, border: `1px solid ${C.crit}`, borderLeft: `4px solid ${C.crit}`, borderRadius: 12, padding: "14px 17px", marginBottom: 16, animation: "pulse 2s ease-in-out infinite" }}>
          <div style={{ width: 32, height: 32, borderRadius: "50%", background: C.crit, display: "grid", placeItems: "center", flex: "none", color: "#fff", fontWeight: 700 }}>!</div>
          <div>
            <div style={{ color: "#f0c0bd", fontFamily: mono, fontSize: 11.5, letterSpacing: ".1em", textTransform: "uppercase", marginBottom: 2 }}>Immediate attention — {agg.band.name} risk</div>
            <div style={{ fontSize: 14, color: C.ink }}>Escalate now. A material financial-crime exposure sits on a current, in-scope party.</div>
          </div>
        </div>
      )}

      {/* verdict */}
      <div style={{ border: `1px solid ${isCrit ? C.crit : C.line2}`, borderRadius: 16, overflow: "hidden", boxShadow: "0 18px 50px -20px rgba(0,0,0,.7)", marginBottom: 20 }}>
        <div style={{ padding: "22px 24px", display: "flex", gap: 22, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <div style={lbl(C)}>Screening result {data.found === false && "· not found in public sources"}</div>
            <h2 style={{ fontFamily: serif, fontSize: 26, fontWeight: 600, lineHeight: 1.1, margin: "0 0 4px" }}>{data.subject || "Subject"}</h2>
            <div style={{ color: C.ink3, fontSize: 12.5, fontFamily: mono }}>{data.descriptor || data.type || ""}</div>
          </div>
          <div style={{ textAlign: "center", flex: "none", minWidth: 150 }}>
            <div style={{ width: 116, height: 116, margin: "0 auto 8px", position: "relative", display: "grid", placeItems: "center" }}>
              <svg width="116" height="116" style={{ position: "absolute", inset: 0, transform: "rotate(-90deg)" }}>
                <circle cx="58" cy="58" r="52" fill="none" stroke={C.line} strokeWidth="9" />
                <circle cx="58" cy="58" r="52" fill="none" stroke={agg.band.hex} strokeWidth="9" strokeLinecap="round" strokeDasharray={circ} strokeDashoffset={off} style={{ transition: "stroke-dashoffset 1s ease .2s" }} />
              </svg>
              <div><div style={{ fontFamily: serif, fontSize: 33, fontWeight: 600, lineHeight: 1 }}>{agg.resolved}</div><div style={{ fontFamily: mono, fontSize: 10, color: C.ink3 }}>/ 10 risk</div></div>
            </div>
            <span style={{ fontFamily: mono, fontWeight: 600, fontSize: 12.5, letterSpacing: ".1em", textTransform: "uppercase", padding: "5px 12px", borderRadius: 6, background: agg.band.hex, color: agg.band.name === "Medium" ? "#1a1305" : "#fff" }}>{agg.band.name}</span>
          </div>
        </div>
        <div style={{ padding: "17px 24px", borderTop: `1px solid ${C.line}`, background: C.panel2 }}>
          <div style={{ ...lbl(C), color: C.gold }}>Case summary</div>
          <p style={{ fontSize: 15, color: C.ink, lineHeight: 1.55, fontFamily: serif, margin: 0 }}>{narr.summary}</p>
        </div>
        <div style={{ display: "flex", gap: 13, alignItems: "center", padding: "15px 24px", borderTop: `1px solid ${C.line}`, flexWrap: "wrap" }}>
          <span style={{ fontFamily: mono, fontWeight: 600, fontSize: 12.5, letterSpacing: ".05em", padding: "8px 13px", borderRadius: 7, background: narr.action[1], color: narr.action[1] === "#c9952f" ? "#1a1305" : "#fff" }}>{narr.action[0]}</span>
          <span style={{ fontSize: 13, color: C.ink2, flex: 1, minWidth: 200 }}>{narr.action[2]}</span>
          <button onClick={onReport} style={{ background: C.panel, border: `1px solid ${C.gold}`, color: C.gold2, fontFamily: sans, fontSize: 13, fontWeight: 500, padding: "9px 14px", borderRadius: 8, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 7 }}>
            <DocIcon /> Generate 1-page report
          </button>
        </div>
      </div>

      {/* metrics */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 10, marginBottom: 8 }}>
        <Metric C={C} v={agg.parties} k="PARTIES" />
        <Metric C={C} v={agg.peps} k="PEP FLAGS" color={agg.peps ? C.amber : C.green} />
        <Metric C={C} v={agg.totalHits} k="ADVERSE HITS" color={agg.totalHits ? C.amber : C.green} />
        <Metric C={C} v={agg.flagged} k="FLAGGED" color={agg.flagged ? C.red : C.green} />
        <Metric C={C} v={agg.contained || "—"} k="CONTAINED" color={agg.contained >= 4 ? C.amber : C.ink} />
      </div>

      {/* ownership tree */}
      <SecTitle C={C}>Beneficial ownership &amp; structure</SecTitle>
      <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, padding: "8px 6px" }}>
        {parties.map((p, i) => {
          const isOff = !inScope(p.relationship, p.current);
          const gc = p.relationship && p.relationship.toLowerCase().includes("client") ? C.blue
            : isOff ? C.red : (p.relationship || "").toLowerCase().includes("ubo") ? C.green : C.blue;
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 13px", borderRadius: 9, position: "relative" }}>
              <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 2, borderRadius: 2, background: gc, opacity: 0.5 }} />
              <div style={{ fontFamily: mono, fontSize: 12, fontWeight: 600, minWidth: 56, textAlign: "right", color: C.ink2 }}>{p.ownership && p.ownership !== "null" ? p.ownership : ""}</div>
              <div style={{ flex: 1, fontSize: 14 }}>
                {p.name}
                <small style={{ color: C.ink3, fontSize: 11.5, fontFamily: mono, display: "block", marginTop: 1 }}>{p.relationship}{isOff ? " · former / non-controlling" : ""}</small>
              </div>
              {p.pep && <span style={tag(C, "#2a2113", C.amber)}>PEP</span>}
              {isOff && <span style={tag(C, "#2a1513", C.red)}>OFF-SCOPE</span>}
            </div>
          );
        })}
      </div>

      {/* party screening */}
      <SecTitle C={C}>Party-by-party screening</SecTitle>
      {parties.map((p, i) => {
        const hits = p.hits || [];
        const dot = p._flag ? C.red : hits.length ? C.amber : C.green;
        const stat = p._flag ? ["MATERIAL HIT", "#2a1513", C.red] : hits.length ? ["REVIEW", "#2a2113", C.amber] : ["CLEAR", "#16271f", C.green];
        return (
          <div key={i} style={{ background: C.panel, border: `1px solid ${p._flag ? C.red : C.line}`, borderRadius: 13, marginBottom: 11, overflow: "hidden" }}>
            <div className="acc" onClick={() => setOpen((o) => o.map((x, j) => (j === i ? !x : x)))} style={{ display: "flex", alignItems: "center", gap: 13, padding: "14px 17px" }}>
              <span style={{ width: 10, height: 10, borderRadius: "50%", background: dot, flex: "none" }} />
              <div style={{ flex: 1 }}>
                <b style={{ fontSize: 14.5 }}>{p.name}</b>
                <small style={{ display: "block", color: C.ink3, fontSize: 11.5, fontFamily: mono, marginTop: 2 }}>{p.relationship}{p.pep ? " · PEP" + (p.pep_detail ? " (" + p.pep_detail + ")" : "") : ""}</small>
              </div>
              <span style={{ fontFamily: mono, fontSize: 11.5, letterSpacing: ".04em", padding: "5px 11px", borderRadius: 6, background: stat[1], color: stat[2] }}>{stat[0]}</span>
            </div>
            {open[i] && (
              <div style={{ borderTop: `1px solid ${C.line}`, padding: "6px 17px 15px", animation: "rise .3s ease both" }}>
                {!hits.length ? (
                  <div style={{ padding: "12px 2px", color: C.green, fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
                    <CheckIcon /> No adverse media returned. {p.pep ? "PEP status noted; apply enhanced due diligence on source of wealth." : "Recorded as screened and clear."}
                  </div>
                ) : (
                  hits.map((h, j) => {
                    const sc = h._sc;
                    return (
                      <div key={j} style={{ border: `1px solid ${C.line}`, borderRadius: 10, padding: 13, marginTop: 11, background: "#11161f" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 14, alignItems: "flex-start", marginBottom: 8 }}>
                          <div>
                            <div style={{ fontWeight: 600, fontSize: 14 }}>{sc.cat}</div>
                            <div style={{ fontFamily: mono, fontSize: 11, color: C.ink3, marginTop: 3 }}>{sc.pf} · {sc.rc} · {sc.sr}</div>
                          </div>
                          <div style={{ textAlign: "center", flex: "none" }}>
                            <div style={{ fontFamily: serif, fontSize: 23, fontWeight: 600, lineHeight: 1, color: sc.band.hex }}>{sc.raw}</div>
                            <span style={{ fontFamily: mono, fontSize: 9.5, letterSpacing: ".06em", textTransform: "uppercase", padding: "2px 7px", borderRadius: 4, marginTop: 3, display: "inline-block", background: sc.band.hex, color: sc.band.name === "Medium" ? "#1a1305" : "#fff" }}>{sc.band.name}</span>
                          </div>
                        </div>
                        <div style={{ fontSize: 13, color: C.ink2, lineHeight: 1.55, marginBottom: 10 }}>{h.summary}</div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", fontFamily: mono, fontSize: 11 }}>
                          <Frag C={C} label="base" v={sc.base} /><span style={{ color: C.ink3 }}>×</span>
                          <Frag C={C} label="proof" v={sc.p} /><span style={{ color: C.ink3 }}>×</span>
                          <Frag C={C} label="recency" v={sc.r} /><span style={{ color: C.ink3 }}>×</span>
                          <Frag C={C} label="source" v={sc.s} /><span style={{ color: C.ink3 }}>=</span>
                          <span style={{ color: C.gold, fontWeight: 600 }}>{sc.raw}</span>
                        </div>
                        <div style={{ marginTop: 11, padding: "10px 12px", borderRadius: 8, fontSize: 12.5, lineHeight: 1.55, borderLeft: `3px solid ${h._effect === "contain" ? C.amber : C.red}`, background: h._effect === "contain" ? "#2a2113" : "#2a1513" }}>
                          <b style={{ fontFamily: mono, fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase", color: C.ink3, display: "block", marginBottom: 4 }}>
                            {h._effect === "contain" ? "Resolution · contained" : "Resolution · sets risk floor"}
                          </b>
                          {h._effect === "contain"
                            ? "Attaches to a former / non-controlling party. Recorded and triggers EDD, but does not set the client's risk floor. Confirm no current control before clearing."
                            : "Attaches to a current, in-scope party. Sets the client's risk floor and drives escalation."}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>
        );
      })}

      {agg.edd && (
        <>
          <SecTitle C={C}>Why the score is contained</SecTitle>
          <div style={{ border: `1px solid ${C.amber}`, background: "#2a2113", borderRadius: 11, padding: "15px 17px", fontSize: 12.5, color: C.ink2, lineHeight: 1.6 }}>
            <b style={{ color: C.ink }}>Entity resolution drove this result.</b> {agg.eddReason} Raw severity peaked at <b>{agg.contained}</b> on a former party, yet the resolved score is <b>{agg.resolved}</b> because that party holds no current control. If EDD found hidden control, the treatment flips to escalation.
          </div>
        </>
      )}

      {data.notes && (
        <div style={{ marginTop: 22, fontSize: 12, color: C.ink3, lineHeight: 1.6, fontFamily: mono }}>
          <b style={{ color: C.ink2 }}>Analyst note from research: </b>{data.notes}
        </div>
      )}

      <div style={{ marginTop: 26, border: `1px dashed ${C.line2}`, borderRadius: 11, padding: "15px 17px", fontSize: 12, color: C.ink3, lineHeight: 1.6 }}>
        <b style={{ color: C.ink2 }}>How to read this.</b> Score = category base × proof × recency × source, per your matrix. A current, in-scope party's worst finding sets the risk floor; findings on former or non-controlling parties are contained. PEP status raises the due-diligence bar but is not itself adverse media. The score is a triage aid, not the decision. Every material hit needs human review and a written rationale.
        <br /><br />
        <b style={{ color: C.ink2 }}>Source.</b> Findings here are assembled live by AI from public web sources and may be incomplete or imperfect. Verify against your licensed screening, PEP and registry providers before acting.
      </div>

      <button onClick={onReset} style={btn(C)}>← Screen another name</button>
    </div>
  );
}

// ============================================================
// 1-PAGE REPORT (print to PDF)
// ============================================================
const ReportModal = React.forwardRef(function ReportModal({ C, result, onClose }, ref) {
  const { data, parties, agg, narr } = result;
  const now = new Date();
  const refNo = "SEN-" + now.getFullYear() + String(now.getMonth() + 1).padStart(2, "0") + String(now.getDate()).padStart(2, "0") + "-" + Math.floor(1000 + Math.random() * 9000);
  const cleanCount = parties.filter((p) => !(p.hits && p.hits.length)).length;
  const rows = [];
  parties.forEach((p) => (p.hits || []).forEach((h) => rows.push({ p, h })));

  return (
    <div onClick={(e) => e.target === e.currentTarget && onClose()} style={{ position: "fixed", inset: 0, background: "rgba(5,8,12,.82)", backdropFilter: "blur(4px)", zIndex: 100, overflowY: "auto", padding: "26px 14px" }}>
      <div className="noprint" style={{ maxWidth: 800, margin: "0 auto 10px", display: "flex", justifyContent: "flex-end", gap: 9 }}>
        <button onClick={onClose} style={{ background: "#fff", color: "#1f3864", border: "1px solid #c7d0dd", fontFamily: sans, fontSize: 13, fontWeight: 500, padding: "9px 15px", borderRadius: 7, cursor: "pointer" }}>Close</button>
        <button onClick={() => window.print()} style={{ background: "#1f3864", color: "#fff", border: "none", fontFamily: sans, fontSize: 13, fontWeight: 500, padding: "9px 15px", borderRadius: 7, cursor: "pointer" }}>Print / Save as PDF</button>
      </div>
      <div className="sheet" style={{ maxWidth: 800, margin: "0 auto", background: "#fbfaf7", color: "#1a1f28", borderRadius: 8, boxShadow: "0 30px 80px -20px #000", padding: "36px 44px 42px", fontFamily: sans }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", borderBottom: "2px solid #1f3864", paddingBottom: 15, marginBottom: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 28, height: 28, border: "1.5px solid #1f3864", borderRadius: 6, display: "grid", placeItems: "center" }}>
              <span style={{ width: 9, height: 9, border: "2px solid #1f3864", borderRadius: "50%" }} />
            </div>
            <div>
              <div style={{ fontFamily: serif, fontSize: 17, color: "#1f3864", fontWeight: 600 }}>Sentinel</div>
              <div style={{ fontFamily: mono, fontSize: 8.5, letterSpacing: ".12em", color: "#6a7585", textTransform: "uppercase" }}>Adverse Media Screening</div>
            </div>
          </div>
          <div style={{ textAlign: "right", fontFamily: mono, fontSize: 9.5, color: "#6a7585", lineHeight: 1.7 }}>
            REF {refNo}<br />{now.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}<br />CONFIDENTIAL — INTERNAL KYC
          </div>
        </div>

        <div style={{ fontFamily: mono, fontSize: 10.5, letterSpacing: ".18em", textTransform: "uppercase", color: "#9a7b2e", marginBottom: 5 }}>Adverse Media &amp; UBO Screening Report</div>
        <div style={{ fontFamily: serif, fontSize: 25, fontWeight: 600, color: "#11161f", lineHeight: 1.1 }}>{data.subject}</div>
        <div style={{ fontFamily: mono, fontSize: 10.5, color: "#6a7585", marginBottom: 18 }}>{data.descriptor || data.type}</div>

        <div style={{ display: "flex", gap: 16, marginBottom: 18 }}>
          <div style={{ flex: "none", width: 125, borderRadius: 8, padding: 15, textAlign: "center", color: "#fff", background: agg.band.hex }}>
            <div style={{ fontFamily: mono, fontSize: 10.5, letterSpacing: ".1em", textTransform: "uppercase", fontWeight: 600 }}>{agg.band.name} risk</div>
            <div style={{ fontFamily: serif, fontSize: 46, fontWeight: 700, lineHeight: 1, margin: "6px 0" }}>{agg.resolved}</div>
            <div style={{ fontFamily: mono, fontSize: 9, opacity: 0.85 }}>out of 10</div>
          </div>
          <div style={{ flex: 1, border: "1px solid #d8d2c4", borderRadius: 8, padding: "13px 15px", background: "#fff" }}>
            <div style={{ fontFamily: mono, fontSize: 9.5, letterSpacing: ".12em", textTransform: "uppercase", color: "#6a7585", marginBottom: 6 }}>Recommended case action</div>
            <span style={{ display: "inline-block", fontFamily: mono, fontWeight: 600, fontSize: 12.5, padding: "6px 11px", borderRadius: 6, marginBottom: 8, background: agg.band.hex + "1a", color: agg.band.hex }}>{narr.action[0]}</span>
            <div style={{ fontSize: 12.5, color: "#3a414c", lineHeight: 1.5 }}>{narr.action[2]}</div>
          </div>
        </div>

        <RepSec>Outcome summary</RepSec>
        <div style={{ fontFamily: serif, fontSize: 14.5, lineHeight: 1.55, color: "#22272f" }}>{narr.summary}</div>

        <RepSec>Screening at a glance</RepSec>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 22px", fontSize: 12.5 }}>
          <KV k="Parties screened" v={agg.parties} />
          <KV k="PEP flags" v={agg.peps} />
          <KV k="Adverse hits found" v={agg.totalHits} />
          <KV k="Parties flagged material" v={agg.flagged} />
          <KV k="Parties screened clean" v={cleanCount} />
          <KV k="Risk floor (in-scope)" v={agg.floor} />
          <KV k="Contained peak (off-scope)" v={agg.contained || "—"} />
        </div>

        <RepSec>Findings detail</RepSec>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5 }}>
          <thead>
            <tr>{["Party", "Category", "Proof / recency / source", "Score", "Effect"].map((h, i) => (
              <th key={i} style={{ background: "#1f3864", color: "#fff", textAlign: "left", padding: "7px 9px", fontFamily: mono, fontSize: 10, fontWeight: 600 }}>{h}</th>
            ))}</tr>
          </thead>
          <tbody>
            {rows.length ? rows.map(({ p, h }, i) => {
              const sc = h._sc;
              return (
                <tr key={i} style={{ background: i % 2 ? "#f4f1ea" : "#fff" }}>
                  <td style={td}><b>{p.name}</b><br /><span style={{ color: "#6a7585" }}>{p.relationship}</span></td>
                  <td style={td}>{sc.cat}</td>
                  <td style={td}>{sc.pf}<br /><span style={{ color: "#6a7585" }}>{sc.rc} · {sc.sr}</span></td>
                  <td style={{ ...td, textAlign: "center" }}><span style={{ display: "inline-block", fontFamily: mono, fontSize: 9.5, fontWeight: 600, padding: "2px 7px", borderRadius: 4, color: "#fff", background: sc.band.hex }}>{sc.raw} {sc.band.name}</span></td>
                  <td style={td}>{h._effect === "contain" ? "Contained — EDD" : "Sets floor"}</td>
                </tr>
              );
            }) : (
              <tr><td colSpan={5} style={{ ...td, textAlign: "center", color: "#6a7585", padding: 14 }}>No adverse media on any screened party.</td></tr>
            )}
          </tbody>
        </table>

        {agg.edd && (<><RepSec>Why the score is contained</RepSec><div style={{ fontSize: 12.5, color: "#3a414c", lineHeight: 1.55, fontFamily: serif }}>{agg.eddReason}</div></>)}

        <RepSec>Scoring basis</RepSec>
        <div style={{ fontSize: 11.5, color: "#3a414c", lineHeight: 1.6 }}>
          Final score = category base × proof multiplier × recency multiplier × source multiplier. A current, in-scope party's worst finding sets the risk floor. Findings on former or non-controlling parties are contained: recorded and routed to Enhanced Due Diligence, but they do not set the floor. PEP status raises the due-diligence bar but is not itself adverse media. The score supports triage and consistency; it does not replace analyst judgment.
        </div>

        <div style={{ display: "flex", gap: 28, marginTop: 18 }}>
          {["Analyst — name / date", "Reviewer (four-eyes) — name / date", "Disposition — approve / EDD / escalate"].map((s, i) => (
            <div key={i} style={{ flex: 1, borderTop: "1px solid #1a1f28", paddingTop: 5, fontFamily: mono, fontSize: 9.5, color: "#6a7585" }}>{s}</div>
          ))}
        </div>

        <div style={{ fontSize: 10.5, color: "#6a7585", lineHeight: 1.55, borderTop: "1px solid #d8d2c4", marginTop: 20, paddingTop: 12 }}>
          <b>Confidential.</b> Prepared by Sentinel for internal KYC use. Findings assembled live by AI from public sources, point-in-time, and may be incomplete. Not legal or investment advice. Verify against current filings and your licensed screening provider before any decision.
        </div>
      </div>
    </div>
  );
});

// ============================================================
// small components
// ============================================================
const td = { padding: "7px 9px", borderBottom: "1px solid #e4dfd2", verticalAlign: "top" };
function RepSec({ children }) {
  return <div style={{ fontFamily: mono, fontSize: 10.5, letterSpacing: ".14em", textTransform: "uppercase", color: "#1f3864", borderBottom: "1px solid #d8d2c4", paddingBottom: 5, margin: "18px 0 10px", fontWeight: 600 }}>{children}</div>;
}
function KV({ k, v }) {
  return <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px dotted #d3cdbf", padding: "5px 0" }}><span style={{ color: "#6a7585" }}>{k}</span><span style={{ fontWeight: 600, color: "#22272f" }}>{v}</span></div>;
}
function Metric({ C, v, k, color }) {
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: "14px 13px" }}>
      <div style={{ fontFamily: serif, fontSize: 26, fontWeight: 600, lineHeight: 1, color: color || C.ink }}>{v}</div>
      <div style={{ fontSize: 10.5, color: C.ink3, marginTop: 5, fontFamily: mono, letterSpacing: ".03em" }}>{k}</div>
    </div>
  );
}
function Frag({ C, label, v }) {
  return <span style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 6, padding: "4px 9px", color: C.ink2 }}>{label} <b style={{ color: C.ink }}>{v}</b></span>;
}
function SecTitle({ C, children }) {
  return <div style={{ fontFamily: mono, fontSize: 12, letterSpacing: ".16em", textTransform: "uppercase", color: C.ink3, margin: "30px 0 13px", display: "flex", alignItems: "center", gap: 12 }}>{children}<span style={{ flex: 1, height: 1, background: C.line }} /></div>;
}
function lbl(C) { return { fontFamily: mono, fontSize: 11, letterSpacing: ".14em", textTransform: "uppercase", color: C.ink3, marginBottom: 7 }; }
function tag(C, bg, fg) { return { fontFamily: mono, fontSize: 10, letterSpacing: ".05em", textTransform: "uppercase", padding: "3px 8px", borderRadius: 5, whiteSpace: "nowrap", background: bg, color: fg }; }
function Mark() {
  return <div style={{ width: 29, height: 29, border: `1px solid ${C.gold}`, borderRadius: 7, display: "grid", placeItems: "center", background: "linear-gradient(160deg,rgba(201,164,76,.18),transparent)" }}><span style={{ width: 9, height: 9, border: `2px solid ${C.gold2}`, borderRadius: "50%" }} /></div>;
}
function SearchIcon() { return <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke={C.ink3} strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>; }
function DocIcon() { return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M9 13h6M9 17h6" /></svg>; }
function CheckIcon() { return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 6 9 17l-5-5" /></svg>; }
