import fs from "node:fs";
import { resolveLiteLLMConfigPath } from "../../../shared/model-managers.js";

export function parseLiteLLMLimits(yamlText) {
  const limits = {};
  if (!yamlText || typeof yamlText !== "string") return limits;

  const lines = yamlText.split(/\r?\n/);
  let currentModel = null;
  let inParams = false;
  let paramsIndent = -1;

  for (const line of lines) {
    const indent = line.match(/^\s*/)?.[0].length || 0;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const modelMatch = trimmed.match(/^- model_name:\s*(.+)\s*$/);
    if (modelMatch) {
      currentModel = modelMatch[1].trim();
      limits[currentModel] = {};
      inParams = false;
      paramsIndent = -1;
      continue;
    }

    if (!currentModel) continue;

    if (trimmed === "litellm_params:") {
      inParams = true;
      paramsIndent = indent;
      continue;
    }

    if (inParams && indent <= paramsIndent) {
      inParams = false;
    }
    if (!inParams) continue;

    const rpmMatch = trimmed.match(/^rpm:\s*([0-9]+)\s*$/);
    if (rpmMatch) {
      limits[currentModel].rpm = Number(rpmMatch[1]);
      continue;
    }

    const tpmMatch = trimmed.match(/^tpm:\s*([0-9]+)\s*$/);
    if (tpmMatch) {
      limits[currentModel].tpm = Number(tpmMatch[1]);
    }
  }

  return limits;
}

export function readLiteLLMLimits(configPath = resolveLiteLLMConfigPath()) {
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    return parseLiteLLMLimits(raw);
  } catch {
    return {};
  }
}
