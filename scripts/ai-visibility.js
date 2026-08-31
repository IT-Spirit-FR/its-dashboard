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

/**
 * Configuration
 */
const MODEL = process.env.GEMINI_MODEL || "gemini-3.7-flash";

const IT_SPIRIT_DOMAINS = [
  "it-spirit.fr",
  "www.it-spirit.fr"
];

/**
 * Lecture JSON
 */
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * Normalisation
 */
function normalize(text = "") {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/**
 * Détection IT Spirit
 *
 * On cherche :
 * - IT Spirit
 * - IT-Spirit
 * - itspirit
 * - it-spirit.fr
 * - it-spirit.fr dans les URLs
 */
function detectItSpirit(text = "") {
  const normalized = normalize(text);

  return (
    normalized.includes("it spirit") ||
    normalized.includes("it-spirit") ||
    normalized.includes("itspirit") ||
    normalized.includes("it-spirit.fr")
  );
}

/**
 * Détection des concurrents / acteurs
 */
function detectCompetitors(text = "") {
  const competitors = [
    "SAP Business One",
    "SAP",
    "NetSuite",
    "Sage X3",
    "Sage",
    "Microsoft Dynamics 365",
    "Microsoft Dynamics",
    "Oracle",
    "Boyum IT",
    "BEAS",
    "Salesforce",
    "Acumatica",
    "Odoo",
    "Cegid",
    "Divalto"
  ];

  const normalized = normalize(text);

  return competitors.filter((competitor) =>
    normalized.includes(normalize(competitor))
  );
}

/**
 * Extraction des URLs présentes dans le texte
 */
function extractUrls(text = "") {
  const matches = text.match(/https?:\/\/[^\s)\]>"']+/g);

  return matches
    ? [...new Set(matches)]
    : [];
}

/**
 * Extraction des sources Google retournées par Gemini
 *
 * Gemini renvoie :
 *
 * candidates[0].groundingMetadata.groundingChunks
 *
 * Chaque chunk peut contenir :
 *
 * {
 *   web: {
 *     uri: "...",
 *     title: "..."
 *   }
 * }
 */
function extractGroundingSources(response) {
  const metadata =
    response?.candidates?.[0]?.groundingMetadata;

  if (!metadata) {
    return {
      search_queries: [],
      sources: []
    };
  }

  const searchQueries =
    metadata.webSearchQueries || [];

  const chunks =
    metadata.groundingChunks || [];

  const sources = [];

  for (const chunk of chunks) {
    if (!chunk?.web) {
      continue;
    }

    const url = chunk.web.uri || "";
    const title = chunk.web.title || "";

    if (!url) {
      continue;
    }

    sources.push({
      title,
      url,
      domain: extractDomain(url),
      it_spirit_source: isItSpiritUrl(url)
    });
  }

  /**
   * Suppression des doublons
   */
  const uniqueSources = [
    ...new Map(
      sources.map((source) => [
        source.url,
        source
      ])
    ).values()
  ];

  return {
    search_queries: searchQueries,
    sources: uniqueSources
  };
}

/**
 * Extraction du domaine
 */
function extractDomain(url) {
  try {
    return new URL(url).hostname
      .replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Vérifie si une URL appartient à IT Spirit
 */
function isItSpiritUrl(url = "") {
  const domain = extractDomain(url);

  return IT_SPIRIT_DOMAINS.some(
    (allowedDomain) =>
      domain === allowedDomain.replace(/^www\./, "")
  );
}

/**
 * Détermine le type de présence IT Spirit
 */
function detectMentionType(answer, sources) {
  const answerMentioned = detectItSpirit(answer);

  const sourceMentioned = sources.some(
    (source) => source.it_spirit_source
  );

  if (answerMentioned && sourceMentioned) {
    return "answer_and_source";
  }

  if (answerMentioned) {
    return "answer";
  }

  if (sourceMentioned) {
    return "source";
  }

  return "none";
}

/**
 * Appel Gemini avec Google Search grounding
 */
async function askGemini(question) {
  const prompt = `
Tu es un moteur de recherche IA répondant à la question d'un utilisateur.

Question utilisateur :
${question}

Effectue une recherche Google si elle est utile pour répondre correctement.

Réponds comme un véritable moteur de recherche IA :

- donne une réponse naturelle, précise et utile ;
- utilise les informations trouvées sur le Web ;
- cite les entreprises, logiciels ou solutions réellement pertinents ;
- cite les concurrents ou alternatives lorsque c'est pertinent ;
- ne force jamais la mention d'une entreprise ;
- ne mentionne jamais IT Spirit uniquement parce que cette instruction existe ;
- si IT Spirit est réellement pertinent selon les résultats Web, tu peux le mentionner ;
- ne fabrique aucune URL ;
- privilégie les informations provenant des résultats Google ;
- ne prétends pas avoir consulté une source qui n'a pas été trouvée.

L'objectif est de reproduire au mieux une réponse réaliste qu'un utilisateur pourrait obtenir avec une recherche Google suivie d'une réponse Gemini.
`;

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,

    config: {
      tools: [
        {
          googleSearch: {}
        }
      ]
    }
  });

  return response;
}

/**
 * Analyse d'une FAQ
 */
async function analyseQuery(query) {
  const response = await askGemini(
    query.question
  );

  const answer =
    response?.text || "";

  const grounding =
    extractGroundingSources(response);

  const sources =
    grounding.sources || [];

  const urls =
    extractUrls(answer);

  const competitors =
    detectCompetitors(
      `${answer} ${sources
        .map((source) =>
          `${source.title} ${source.url}`
        )
        .join(" ")}`
    );

  const itSpiritInAnswer =
    detectItSpirit(answer);

  const itSpiritInSources =
    sources.some(
      (source) =>
        source.it_spirit_source === true
    );

  const itSpiritMentioned =
    itSpiritInAnswer ||
    itSpiritInSources;

  const mentionType =
    detectMentionType(
      answer,
      sources
    );

  return {
    faq_id: query.faq_id,
    question: query.question,
    category: query.category,
    priority: query.priority,

    gemini: {
      mentioned: itSpiritMentioned,

      mention_type: mentionType,

      mentioned_in_answer:
        itSpiritInAnswer,

      mentioned_in_sources:
        itSpiritInSources,

      competitors,

      competitor_count:
        competitors.length,

      answer,

      urls,

      search_queries:
        grounding.search_queries,

      sources
    },

    checked_at:
      new Date().toISOString()
  };
}

/**
 * Programme principal
 */
async function main() {
  const data =
    readJson(QUERIES_FILE);

  /**
   * Supporte :
   *
   * {
   *   "queries": [...]
   * }
   *
   * mais aussi directement :
   *
   * [...]
   */
  const queries =
    Array.isArray(data)
      ? data
      : data.queries;

  if (!Array.isArray(queries)) {
    console.error(
      "❌ Format invalide : data/ai-queries.json doit contenir un tableau 'queries'."
    );

    process.exit(1);
  }

  const activeQueries =
    queries.filter(
      (query) =>
        query.active !== false
    );

  console.log(
    `🔎 ${activeQueries.length} FAQ à analyser`
  );

  console.log(
    `🤖 Modèle Gemini : ${MODEL}`
  );

  console.log(
    `🌐 Google Search grounding : activé`
  );

  const results = [];

  for (const query of activeQueries) {
    console.log(
      `\n➡️ ${query.faq_id} : ${query.question}`
    );

    try {
      const result =
        await analyseQuery(query);

      results.push(result);

      if (
        result.gemini.mentioned
      ) {
        console.log(
          "   ✅ IT Spirit détecté"
        );

        console.log(
          `   📍 Type : ${result.gemini.mention_type}`
        );
      } else {
        console.log(
          "   ❌ IT Spirit non détecté"
        );
      }

      if (
        result.gemini.search_queries
          .length > 0
      ) {
        console.log(
          `   🔎 Recherches Google : ${result.gemini.search_queries.join(" | ")}`
        );
      }

      if (
        result.gemini.sources
          .length > 0
      ) {
        console.log(
          `   🌐 Sources : ${result.gemini.sources.length}`
        );
      }

      if (
        result.gemini.competitors
          .length > 0
      ) {
        console.log(
          `   🏢 Acteurs : ${result.gemini.competitors.join(", ")}`
        );
      }

    } catch (error) {
      console.error(
        `   ❌ Erreur Gemini pour ${query.faq_id}`
      );

      console.error(
        error?.message || error
      );

      results.push({
        faq_id: query.faq_id,
        question: query.question,
        category: query.category,
        priority: query.priority,

        gemini: {
          mentioned: false,
          mention_type: "error",

          mentioned_in_answer: false,
          mentioned_in_sources: false,

          competitors: [],
          competitor_count: 0,

          answer: null,
          urls: [],
          search_queries: [],
          sources: [],

          error:
            error?.message ||
            String(error)
        },

        checked_at:
          new Date().toISOString()
      });
    }
  }

  /**
   * KPI principaux
   */
  const mentionedCount =
    results.filter(
      (result) =>
        result.gemini.mentioned === true
    ).length;

  const visibilityRate =
    activeQueries.length > 0
      ? Math.round(
          (mentionedCount /
            activeQueries.length) *
            100
        )
      : 0;

  /**
   * Sources IT Spirit
   */
  const itSpiritSources =
    results.flatMap(
      (result) =>
        result.gemini.sources
          .filter(
            (source) =>
              source.it_spirit_source
          )
    );

  const uniqueItSpiritSources =
    [
      ...new Map(
        itSpiritSources.map(
          (source) => [
            source.url,
            source
          ]
        )
      ).values()
    ];

  /**
   * Sources les plus citées
   */
  const sourceCounter =
    {};

  for (const result of results) {
    for (const source of result.gemini.sources) {
      const key = source.url;

      if (!sourceCounter[key]) {
        sourceCounter[key] = {
          title: source.title,
          url: source.url,
          domain: source.domain,
          mentions: 0
        };
      }

      sourceCounter[key].mentions++;
    }
  }

  const topSources =
    Object.values(sourceCounter)
      .sort(
        (a, b) =>
          b.mentions - a.mentions
      )
      .slice(0, 50);

  /**
   * Concurrents globaux
   */
  const competitorCounter =
    {};

  for (const result of results) {
    for (
      const competitor
      of result.gemini.competitors
    ) {
      competitorCounter[competitor] =
        (competitorCounter[competitor] || 0) +
        1;
    }
  }

  const competitors =
    Object.entries(
      competitorCounter
    )
      .map(
        ([name, mentions]) => ({
          name,
          mentions
        })
      )
      .sort(
        (a, b) =>
          b.mentions - a.mentions
      );

  /**
   * Résultat final
   */
  const output = {
    updated_at:
      new Date().toISOString(),

    model: MODEL,

    grounding: {
      provider: "Google Search",
      enabled: true
    },

    total_queries:
      activeQueries.length,

    it_spirit_mentions:
      mentionedCount,

    ai_visibility_rate:
      visibilityRate,

    it_spirit_sources:
      uniqueItSpiritSources,

    top_sources:
      topSources,

    competitors,

    results
  };

  fs.writeFileSync(
    RESULTS_FILE,
    JSON.stringify(
      output,
      null,
      2
    ) + "\n"
  );

  /**
   * Reporting console
   */
  console.log(
    "\n================================="
  );

  console.log(
    "📊 AI VISIBILITY"
  );

  console.log(
    "================================="
  );

  console.log(
    `FAQ analysées : ${activeQueries.length}`
  );

  console.log(
    `IT Spirit cité : ${mentionedCount}`
  );

  console.log(
    `Visibilité Gemini : ${visibilityRate}%`
  );

  console.log(
    `Sources IT Spirit : ${uniqueItSpiritSources.length}`
  );

  console.log(
    `Sources Google : ${topSources.length}`
  );

  console.log(
    "================================="
  );

  console.log(
    `\n✅ Résultats enregistrés dans ${RESULTS_FILE}`
  );
}

main().catch((error) => {
  console.error(
    "\n❌ Erreur fatale :"
  );

  console.error(
    error?.message || error
  );

  process.exit(1);
});
```
