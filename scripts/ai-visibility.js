import { GoogleGenAI } from "@google/genai";
import fs from "fs";

const QUERIES_FILE = "data/ai-queries.json";
const RESULTS_FILE = "data/ai-results.json";

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  console.error("GEMINI_API_KEY est manquante.");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });

const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";

const IT_SPIRIT_DOMAINS = [
  "it-spirit.fr",
  "www.it-spirit.fr",
];

const BATCH_SIZE = 15;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function normalize(text = "") {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function detectItSpirit(text = "") {
  const normalized = normalize(text);

  return (
    normalized.includes("it spirit") ||
    normalized.includes("it-spirit") ||
    normalized.includes("itspirit") ||
    normalized.includes("it-spirit.fr")
  );
}

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isItSpiritUrl(url = "") {
  const domain = extractDomain(url);

  return IT_SPIRIT_DOMAINS.some(
    (allowedDomain) =>
      domain === allowedDomain.replace(/^www\./, "")
  );
}

function extractUrls(text = "") {
  const matches = text.match(
    /https?:\/\/[^\s)\]>"']+/g
  );

  return matches ? [...new Set(matches)] : [];
}

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
    "Divalto",
  ];

  const normalized = normalize(text);

  return competitors.filter((competitor) =>
    normalized.includes(normalize(competitor))
  );
}

function extractGroundingSources(response) {
  const metadata =
    response?.candidates?.[0]?.groundingMetadata;

  if (!metadata) {
    return {
      search_queries: [],
      sources: [],
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
      it_spirit_source: isItSpiritUrl(url),
    });
  }

  const uniqueSources = [
    ...new Map(
      sources.map((source) => [
        source.url,
        source,
      ])
    ).values(),
  ];

  return {
    search_queries: searchQueries,
    sources: uniqueSources,
  };
}

function detectMentionType(answer, sources) {
  const answerMentioned =
    detectItSpirit(answer);

  const sourceMentioned =
    sources.some(
      (source) =>
        source.it_spirit_source === true
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

async function askGemini(question) {
  const prompt = `
Tu es un moteur de recherche IA répondant à la question d'un utilisateur.

Question utilisateur :
${question}

Effectue une recherche sur le Web afin de fournir une réponse réaliste et actuelle.

Réponds de manière naturelle, précise et informative.

Consignes :
- utilise les informations trouvées sur le Web ;
- cite les entreprises, logiciels et solutions réellement pertinents ;
- cite les concurrents ou alternatives lorsque c'est pertinent ;
- ne force jamais la mention d'une entreprise ;
- ne mentionne pas IT Spirit simplement parce que cette consigne existe ;
- si IT Spirit est réellement pertinent dans les résultats Web, tu peux le mentionner ;
- ne fabrique aucune URL ;
- ne prétends pas avoir consulté une source qui n'a pas été trouvée ;
- privilégie les informations issues des résultats de recherche.

L'objectif est de reproduire au mieux une réponse réaliste qu'un utilisateur pourrait obtenir d'un moteur de recherche IA utilisant la recherche Web.
`;

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      tools: [
        {
          googleSearch: {},
        },
      ],
    },
  });

  return response;
}

async function analyseQuery(query) {
  const response = await askGemini(
    query.question
  );

  const answer = response?.text || "";

  const grounding =
    extractGroundingSources(response);

  const sources =
    grounding.sources || [];

  const urls = extractUrls(answer);

  const sourceText = sources
    .map(
      (source) =>
        `${source.title} ${source.url}`
    )
    .join(" ");

  const competitors = detectCompetitors(
    `${answer} ${sourceText}`
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

  return {
    faq_id: query.faq_id,
    question: query.question,
    category: query.category,
    priority: query.priority,

    gemini: {
      mentioned: itSpiritMentioned,

      mention_type: detectMentionType(
        answer,
        sources
      ),

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

      sources,
    },

    checked_at:
      new Date().toISOString(),
  };
}

function getBatchForToday(queries) {
  const today = new Date();

  const dayOfWeek = today.getDay();

  /*
   * JavaScript :
   * 0 = dimanche
   * 1 = lundi
   * 2 = mardi
   * 3 = mercredi
   * ...
   *
   * Lundi    => batch 0
   * Mardi    => batch 1
   * Mercredi => batch 2
   */

  let batchIndex;

  if (dayOfWeek === 1) {
    batchIndex = 0;
  } else if (dayOfWeek === 2) {
    batchIndex = 1;
  } else if (dayOfWeek === 3) {
    batchIndex = 2;
  } else {
    /*
     * Pour un lancement manuel hors lundi/mardi/mercredi,
     * on choisit le groupe en fonction de la semaine.
     */
    const weekNumber = getWeekNumber(today);
    batchIndex = weekNumber % 3;
  }

  const start =
    batchIndex * BATCH_SIZE;

  const end =
    Math.min(
      start + BATCH_SIZE,
      queries.length
    );

  return {
    batchIndex,
    start,
    end,
    queries: queries.slice(start, end),
  };
}

function getWeekNumber(date) {
  const d = new Date(
    Date.UTC(
      date.getFullYear(),
      date.getMonth(),
      date.getDate()
    )
  );

  const dayNum = d.getUTCDay() || 7;

  d.setUTCDate(
    d.getUTCDate() + 4 - dayNum
  );

  const yearStart = new Date(
    Date.UTC(
      d.getUTCFullYear(),
      0,
      1
    )
  );

  return Math.ceil(
    (
      (
        (d - yearStart) / 86400000
      ) + 1
    ) / 7
  );
}

function loadPreviousResults() {
  if (!fs.existsSync(RESULTS_FILE)) {
    return [];
  }

  try {
    const previous =
      readJson(RESULTS_FILE);

    if (
      Array.isArray(previous.results)
    ) {
      return previous.results;
    }

    return [];
  } catch (error) {
    console.warn(
      "Impossible de lire les anciens résultats. Un nouveau fichier sera créé."
    );

    return [];
  }
}

function mergeResults(
  previousResults,
  newResults
) {
  const resultsMap = new Map();

  for (const result of previousResults) {
    resultsMap.set(
      result.faq_id,
      result
    );
  }

  for (const result of newResults) {
    resultsMap.set(
      result.faq_id,
      result
    );
  }

  return [...resultsMap.values()]
    .sort((a, b) =>
      a.faq_id.localeCompare(
        b.faq_id,
        undefined,
        {
          numeric: true,
        }
      )
    );
}

function calculateStatistics(results) {
  const mentionedCount =
    results.filter(
      (result) =>
        result.gemini?.mentioned === true
    ).length;

  const visibilityRate =
    results.length > 0
      ? Math.round(
          (mentionedCount /
            results.length) *
            100
        )
      : 0;

  const itSpiritSources =
    results.flatMap((result) =>
      (result.gemini?.sources || [])
        .filter(
          (source) =>
            source.it_spirit_source === true
        )
    );

  const uniqueItSpiritSources = [
    ...new Map(
      itSpiritSources.map(
        (source) => [
          source.url,
          source,
        ]
      )
    ).values(),
  ];

  const sourceCounter = {};

  for (const result of results) {
    for (const source of
      result.gemini?.sources || []) {
      if (!sourceCounter[source.url]) {
        sourceCounter[source.url] = {
          title: source.title,
          url: source.url,
          domain: source.domain,
          mentions: 0,
        };
      }

      sourceCounter[source.url]
        .mentions++;
    }
  }

  const topSources =
    Object.values(sourceCounter)
      .sort(
        (a, b) =>
          b.mentions - a.mentions
      )
      .slice(0, 50);

  const competitorCounter = {};

  for (const result of results) {
    for (const competitor of
      result.gemini?.competitors || []) {
      competitorCounter[competitor] =
        (competitorCounter[competitor] ||
          0) + 1;
    }
  }

  const competitors =
    Object.entries(
      competitorCounter
    )
      .map(
        ([name, mentions]) => ({
          name,
          mentions,
        })
      )
      .sort(
        (a, b) =>
          b.mentions - a.mentions
      );

  return {
    mentionedCount,
    visibilityRate,
    uniqueItSpiritSources,
    topSources,
    competitors,
  };
}

async function main() {
  const data =
    readJson(QUERIES_FILE);

  const queries =
    Array.isArray(data)
      ? data
      : data.queries;

  if (!Array.isArray(queries)) {
    console.error(
      "Format invalide : data/ai-queries.json doit contenir un tableau queries."
    );

    process.exit(1);
  }

  const activeQueries =
    queries.filter(
      (query) =>
        query.active !== false
    );

  const batch =
    getBatchForToday(
      activeQueries
    );

  console.log(
    `FAQ actives : ${activeQueries.length}`
  );

  console.log(
    `Modèle Gemini : ${MODEL}`
  );

  console.log(
    "Google Search grounding : activé"
  );

  console.log(
    `Groupe du jour : ${batch.batchIndex + 1}/3`
  );

  console.log(
    `FAQ traitées aujourd'hui : ${batch.start + 1}-${batch.end}`
  );

  console.log(
    `Nombre de requêtes aujourd'hui : ${batch.queries.length}`
  );

  const previousResults =
    loadPreviousResults();

  const results = [];

  for (const query of batch.queries) {
    console.log(
      `\n${query.faq_id} : ${query.question}`
    );

    try {
      const result =
        await analyseQuery(query);

      results.push(result);

      if (
        result.gemini.mentioned
      ) {
        console.log(
          "IT Spirit détecté"
        );

        console.log(
          `Type : ${result.gemini.mention_type}`
        );
      } else {
        console.log(
          "IT Spirit non détecté"
        );
      }

      if (
        result.gemini.search_queries
          .length > 0
      ) {
        console.log(
          `Recherches : ${result.gemini.search_queries.join(" | ")}`
        );
      }

      if (
        result.gemini.sources.length > 0
      ) {
        console.log(
          `Sources : ${result.gemini.sources.length}`
        );
      }

      if (
        result.gemini.competitors
          .length > 0
      ) {
        console.log(
          `Acteurs : ${result.gemini.competitors.join(", ")}`
        );
      }
    } catch (error) {
      console.error(
        `Erreur Gemini pour ${query.faq_id}`
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
            String(error),
        },

        checked_at:
          new Date().toISOString(),
      });
    }
  }

  /*
   * On fusionne les nouveaux résultats
   * avec ceux déjà présents.
   */
  const mergedResults =
    mergeResults(
      previousResults,
      results
    );

  const statistics =
    calculateStatistics(
      mergedResults
    );

  const output = {
    updated_at:
      new Date().toISOString(),

    model: MODEL,

    grounding: {
      provider: "Google Search",
      enabled: true,
    },

    total_queries:
      mergedResults.length,

    it_spirit_mentions:
      statistics.mentionedCount,

    ai_visibility_rate:
      statistics.visibilityRate,

    it_spirit_sources:
      statistics.uniqueItSpiritSources,

    top_sources:
      statistics.topSources,

    competitors:
      statistics.competitors,

    results:
      mergedResults,
  };

  fs.writeFileSync(
    RESULTS_FILE,
    JSON.stringify(
      output,
      null,
      2
    ) + "\n"
  );

  console.log(
    "\n================================="
  );

  console.log(
    "AI VISIBILITY"
  );

  console.log(
    "================================="
  );

  console.log(
    `FAQ actives : ${activeQueries.length}`
  );

  console.log(
    `FAQ traitées aujourd'hui : ${results.length}`
  );

  console.log(
    `Résultats conservés : ${mergedResults.length}`
  );

  console.log(
    `IT Spirit cité : ${statistics.mentionedCount}`
  );

  console.log(
    `Visibilité Gemini : ${statistics.visibilityRate}%`
  );

  console.log(
    `Sources IT Spirit : ${statistics.uniqueItSpiritSources.length}`
  );

  console.log(
    `Sources Google : ${statistics.topSources.length}`
  );

  console.log(
    "================================="
  );

  console.log(
    `Résultats enregistrés dans ${RESULTS_FILE}`
  );
}

main().catch((error) => {
  console.error(
    "\nErreur fatale :"
  );

  console.error(
    error?.message || error
  );

  process.exit(1);
});
