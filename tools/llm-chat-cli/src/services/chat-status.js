import { stderr } from "node:process";
import { DEFAULT_GATEWAY_MODEL } from "../infrastructure/chat-config.js";
import { calculateRemainingFromLimits } from "../domain/usage.js";
import { getUsageLedger } from "./usage.js";

export function createStatusState({
  sessionUsage,
  estimatedTokens,
  routing,
  ledgerTotals,
  authEnabled
}) {
  return {
    sessionUsage,
    estimatedTokens,
    routing,
    ledgerTotals,
    authEnabled
  };
}

export function createStatusLine(state) {
  const lane = state.routing?.lane || "unknown";
  const model = state.routing?.targetModel || DEFAULT_GATEWAY_MODEL;
  return (
    `[tokens session=${state.sessionUsage.total_tokens}` +
    ` all_time=${state.ledgerTotals.total_tokens}` +
    ` est=${state.estimatedTokens}` +
    ` lane=${lane}` +
    ` model=${model}` +
    ` auth=${state.authEnabled ? "on" : "off"}]`
  );
}

export function createStatusRenderer({ stream = stderr } = {}) {
  const canRender = Boolean(stream?.isTTY);

  return {
    render(text) {
      if (!canRender) return;
      const line = String(text || "");
      if (!line) return;
      stream.write(`${line}\n`);
    },
    clear() {},
    isEnabled() {
      return canRender;
    }
  };
}

export function createUsageSummary({
  sessionUsage,
  estimatedTokens,
  routing,
  limitsByModel
}) {
  const ledger = getUsageLedger();
  const modelName = routing?.targetModel || DEFAULT_GATEWAY_MODEL;
  const remaining = calculateRemainingFromLimits({
    limitsByModel,
    modelName,
    usedPromptTokens: sessionUsage.prompt_tokens,
    usedCompletionTokens: sessionUsage.completion_tokens
  });

  return {
    allTimeTotalTokens: ledger.totals.total_tokens,
    sessionTotalTokens: sessionUsage.total_tokens,
    sessionEstimatedTokens: estimatedTokens,
    model: remaining.model,
    remainingTpm: remaining.tpmRemaining,
    remainingRpm: remaining.rpmRemaining,
    quotaRefresh: remaining.resetsIn
  };
}

export function formatUsagePanel(summary) {
  return [
    `all_time_total_tokens: ${summary.allTimeTotalTokens}`,
    `session_total_tokens: ${summary.sessionTotalTokens}`,
    `session_estimated_tokens: ${summary.sessionEstimatedTokens}`,
    `model: ${summary.model}`,
    `remaining_tpm: ${summary.remainingTpm}`,
    `remaining_rpm: ${summary.remainingRpm}`,
    `quota_refresh: ${summary.quotaRefresh}`
  ];
}

export function formatUsageScreenLines(summary) {
  return [
    "| Field | Value |",
    "| --- | --- |",
    `| All-time total tokens | ${summary.allTimeTotalTokens} |`,
    `| Session total tokens | ${summary.sessionTotalTokens} |`,
    `| Session estimated tokens | ${summary.sessionEstimatedTokens} |`,
    `| Model | ${summary.model} |`,
    `| Remaining TPM | ${summary.remainingTpm} |`,
    `| Remaining RPM | ${summary.remainingRpm} |`,
    `| Quota refresh | ${summary.quotaRefresh} |`,
    "",
    "Usage : `/back` | `/conv`"
  ];
}

export function printUsageSummary({
  sessionUsage,
  estimatedTokens,
  routing,
  limitsByModel
}) {
  const summary = createUsageSummary({
    sessionUsage,
    estimatedTokens,
    routing,
    limitsByModel
  });
  console.log("Usage:");
  for (const line of formatUsagePanel(summary)) {
    console.log(`  ${line}`);
  }
}
