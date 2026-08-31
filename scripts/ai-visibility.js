import { GoogleGenAI } from "@google/genai";
import fs from "fs";

const QUERIES_FILE = "data/ai-queries.json";
const RESULTS_FILE = "data/ai-results.json";

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  console.error("❌ GEMINI_API_KEY est manquante.");
  process.exit(1);
}

const ai = new GoogleGenAI({
  apiKey
});

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function extractUrls(text) {
  const matches = text.match(/https?:\/\/[^\s)\]>"']+/g);
  return matches ? [...new Set(matches)] : [];
}

function detectItSpirit(text) {
  const normalized = text.toLowerCase();

  return (
    normalized.includes("it spirit") ||
    normalized.includes("it-spirit") ||
    normalized.includes("itspirit") ||
    normalized.includes("it-spirit.fr")
  );
}

function detectCompetitors(text) {
  const competitors = [
    "SAP",
    "SAP Business One",
    "NetSuite",
    "Sage",
    "Sage X3",
    "Microsoft Dynamics",
    "Microsoft Dynamics 365",
    "Oracle",
    "Boyum IT",
    "BEAS",
    "Salesforce",
    "Acumatica",
    "Odoo",
    "Cegid",
    "Divalto"
  ];

  const normalized = text.toLowerCase();

  return competitors.filter((competitor) =>
    normalized.includes(competitor.toLowerCase())
  );
}

async function askGemini(question) {
  const prompt = `
Tu es un moteur de recherche IA répondant à la question d'un utilisateur.

Question :
${question}

Réponds de manière naturelle, précise et informative.

Lorsque c'est pertinent :
- cite les entreprises ou solutions les plus pertinentes ;
- cite les concurrents ou alternatives ;
- cite les sources et URLs que tu connais ;
- ne force jamais la mention d'une entreprise ;
- ne mentionne pas IT Spirit simplement parce que la question contient cette consigne.

L'objectif est de reproduire une réponse réaliste qu'un utilisateur pourrait obtenir d'un moteur de recherche IA.
`;

  const response = await ai.models.generateContent({
    model: process.env.GEMINI_MODEL || "gemini-3.6-flash",
    contents: prompt
  });

  return response.text || "";
}

async function main() {
  const data = readJson(QUERIES_FILE);

  if (!data.queries || !Array.isArray(data.queries)) {
    console.error(
      "❌ Format invalide : data/ai-queries.json doit contenir un tableau 'queries'."
    );
    process.exit(1);
  }

  const activeQueries = data.queries;

  console.log(`🔎 ${activeQueries.length} FAQ à analyser`);

  const results = [];

  for (const query of activeQueries) {
    console.log(`➡️ ${query.faq_id} : ${query.question}`);

    try {
      const answer = await askGemini(query.question);

      const urls = extractUrls(answer);
      const itSpiritMentioned = detectItSpirit(answer);
      const competitors = detectCompetitors(answer);

      results.push({
        faq_id: query.faq_id,
        question: query.question,
        category: query.category,
        priority: query.priority,

        gemini: {
          mentioned: itSpiritMentioned,
          competitors: competitors,
          competitor_count: competitors.length,
          answer: answer,
          urls: urls
        },

        checked_at: new Date().toISOString()
      });

      console.log(
        itSpiritMentioned
          ? "   ✅ IT Spirit détecté"
          : "   ❌ IT Spirit non détecté"
      );

      if (competitors.length > 0) {
        console.log(
          `   🏢 Concurrents/acteurs détectés : ${competitors.join(", ")}`
        );
      }

    } catch (error) {
      console.error(`   ❌ Erreur Gemini pour ${query.faq_id}`);
      console.error(error.message);

      results.push({
        faq_id: query.faq_id,
        question: query.question,
        category: query.category,
        priority: query.priority,

        gemini: {
          mentioned: false,
          competitors: [],
          competitor_count: 0,
          answer: null,
          urls: [],
          error: error.message
        },

        checked_at: new Date().toISOString()
      });
    }
  }

  const mentionedCount = results.filter(
    (result) => result.gemini.mentioned === true
  ).length;

  const visibilityRate =
    activeQueries.length > 0
      ? Math.round((mentionedCount / activeQueries.length) * 100)
      : 0;

  const output = {
    updated_at: new Date().toISOString(),
    total_queries: activeQueries.length,
    it_spirit_mentions: mentionedCount,
    ai_visibility_rate: visibilityRate,
    results
  };

  fs.writeFileSync(
    RESULTS_FILE,
    JSON.stringify(output, null, 2) + "\n"
  );

  console.log("\n=================================");
  console.log("📊 AI VISIBILITY");
  console.log("=================================");
  console.log(`FAQ analysées : ${activeQueries.length}`);
  console.log(`IT Spirit cité : ${mentionedCount}`);
  console.log(`Visibilité IA : ${visibilityRate}%`);
  console.log("=================================");

  console.log(`\n✅ Résultats enregistrés dans ${RESULTS_FILE}`);
}

main();
