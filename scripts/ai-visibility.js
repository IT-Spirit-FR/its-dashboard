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
    normalized.includes("itspirit")
  );
}

async function askGemini(question) {
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: `
Tu es un moteur de recherche répondant à la question d'un utilisateur.

Question :
${question}

Réponds de manière naturelle et informative.

Si tu recommandes des entreprises, solutions ou sources, cite leurs noms et, lorsque tu les connais, leurs URLs.
`
  });

  return response.text || "";
}

async function main() {
  const queries = readJson(QUERIES_FILE);

  const activeQueries = queries.filter((query) => query.active === true);

  console.log(`🔎 ${activeQueries.length} FAQ à analyser`);

  const results = [];

  for (const query of activeQueries) {
    console.log(`➡️ ${query.id} : ${query.question}`);

    try {
      const answer = await askGemini(query.question);

      const urls = extractUrls(answer);
      const itSpiritMentioned = detectItSpirit(answer);

      results.push({
        faq_id: query.id,
        question: query.question,
        category: query.category,
        priority: query.priority,

        gemini: {
          mentioned: itSpiritMentioned,
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

    } catch (error) {
      console.error(`   ❌ Erreur Gemini pour ${query.id}`);
      console.error(error.message);

      results.push({
        faq_id: query.id,
        question: query.question,
        category: query.category,
        priority: query.priority,

        gemini: {
          mentioned: false,
          answer: null,
          urls: [],
          error: error.message
        },

        checked_at: new Date().toISOString()
      });
    }
  }

  const output = {
    updated_at: new Date().toISOString(),
    total_queries: activeQueries.length,
    results
  };

  fs.writeFileSync(
    RESULTS_FILE,
    JSON.stringify(output, null, 2) + "\n"
  );

  console.log(`\n✅ Résultats enregistrés dans ${RESULTS_FILE}`);
}

main();
