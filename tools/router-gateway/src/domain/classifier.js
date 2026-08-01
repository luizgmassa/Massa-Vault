import fs from "node:fs";
import path from "node:path";
import { extractUserText, hasMultimodalPayload } from "./extract-text.js";

const DEFAULT_POLICY = {
  version: 1,
  confidenceFloor: 0.55,
  lanes: {
    code: { model: "smart-router-code", phrases: [] },
    multimodal: { model: "smart-router-multimodal", phrases: [] },
    general: { model: "smart-router-general", phrases: [] }
  }
};

function safeLower(value) {
  return String(value || "").toLowerCase();
}

function scoreFromPhrases(text, phrases) {
  if (!phrases || !phrases.length) return 0;
  let score = 0;
  for (const phrase of phrases) {
    const token = safeLower(phrase).trim();
    if (!token) continue;
    if (text.includes(token)) score += 1;
  }
  return score;
}

export function loadPolicy(policyPath) {
  const absolutePath = path.resolve(policyPath);
  const raw = fs.readFileSync(absolutePath, "utf8");
  const parsed = JSON.parse(raw);
  return {
    ...DEFAULT_POLICY,
    ...parsed,
    lanes: {
      ...DEFAULT_POLICY.lanes,
      ...parsed.lanes
    }
  };
}

export function classifyRequest(body, policy) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const text = safeLower(extractUserText(messages));
  const context = body?.context && typeof body.context === "object" ? body.context : {};

  const rawScores = {
    code: scoreFromPhrases(text, policy.lanes.code.phrases),
    multimodal: scoreFromPhrases(text, policy.lanes.multimodal.phrases),
    general: 1
  };

  if (hasMultimodalPayload(messages)) {
    rawScores.multimodal += 3;
  }

  if (Number(context.selection_length) > 900) {
    rawScores.code += 1;
  }

  const total = rawScores.code + rawScores.multimodal + rawScores.general;
  const normalized = {
    code: total ? rawScores.code / total : 0,
    multimodal: total ? rawScores.multimodal / total : 0,
    general: total ? rawScores.general / total : 1
  };

  const sorted = Object.entries(normalized).sort((a, b) => b[1] - a[1]);
  const bestLane = sorted[0][0];
  const bestScore = sorted[0][1];

  const lane = bestScore < Number(policy.confidenceFloor || 0.55) ? "general" : bestLane;
  const targetModel = policy.lanes?.[lane]?.model || "smart-router-general";

  return {
    lane,
    confidence: bestScore,
    targetModel,
    scores: normalized,
    extractedText: text
  };
}
