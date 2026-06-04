function escapeMarkdownTableCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function truncateText(value, limit = 88) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function formatTimestamp(value) {
  const text = String(value || "").trim();
  return text || "-";
}

function splitSnippet(value) {
  const text = String(value || "").trim();
  if (!text) return [];
  return text.split(/\r?\n/).slice(-10);
}

function backendStatusLabel(backend) {
  if (backend?.hasError) return "Error";
  if (backend?.enabled === false) return "Disabled";
  return "OK";
}

export function buildMarkdownTable(headers, rows) {
  const safeHeaders = (Array.isArray(headers) ? headers : []).map((header) =>
    escapeMarkdownTableCell(header)
  );
  const safeRows = (Array.isArray(rows) ? rows : []).map((row) =>
    (Array.isArray(row) ? row : []).map((cell) => escapeMarkdownTableCell(cell))
  );

  return [
    `| ${safeHeaders.join(" | ")} |`,
    `| ${safeHeaders.map(() => "---").join(" | ")} |`,
    ...safeRows.map((row) => `| ${row.join(" | ")} |`)
  ];
}

export function createInfoPanelState({
  id = "panel",
  title = "Info",
  lines = [],
  scrollable = false,
  renderMarkdown = true,
  commandHint = "slash commands"
} = {}) {
  return {
    id: String(id || "panel"),
    title: String(title || "Info"),
    lines: Array.isArray(lines) ? lines : [],
    scrollable: Boolean(scrollable),
    renderMarkdown: renderMarkdown !== false,
    commandHint: String(commandHint || "slash commands")
  };
}

export function createInfoScreenAction(options = {}) {
  return {
    type: "switch-screen",
    screen: "panel",
    panelScreen: createInfoPanelState(options)
  };
}

export function formatKeyValueScreenLines({
  rows = [],
  emptyText = "No data available.",
  footerLines = []
} = {}) {
  const lines = [];
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    lines.push(emptyText);
  } else {
    lines.push(...buildMarkdownTable(["Field", "Value"], list));
  }
  if (footerLines.length) {
    lines.push("", ...footerLines);
  }
  return lines;
}

export function formatJsonScreenLines({
  data,
  emptyText = "No data available.",
  footerLines = []
} = {}) {
  const lines = [];
  if (!data || typeof data !== "object") {
    lines.push(emptyText);
  } else {
    lines.push("```json");
    lines.push(...JSON.stringify(data, null, 2).split("\n"));
    lines.push("```");
  }
  if (footerLines.length) {
    lines.push("", ...footerLines);
  }
  return lines;
}

export function formatTextScreenLines({
  text = "",
  emptyText = "[empty]",
  footerLines = []
} = {}) {
  const lines = [];
  const body = String(text || "").trim();
  lines.push("```text");
  lines.push(...(body ? body.split(/\r?\n/) : [emptyText]));
  lines.push("```");
  if (footerLines.length) {
    lines.push("", ...footerLines);
  }
  return lines;
}

export function formatCommandScreenLines(definitions = []) {
  const rows = (Array.isArray(definitions) ? definitions : []).map((definition) => [
    definition.requiresInput ? `${definition.command} ...` : definition.command,
    definition.description || "-"
  ]);
  return [
    ...buildMarkdownTable(["Command", "Description"], rows),
    "",
    "Tip : type a slash command in prompt | `/back` | `/conv`"
  ];
}

export function formatSyncStatusScreenLines(syncStatus) {
  const backendGit = syncStatus?.backends?.git || { enabled: null, hasError: false };
  const backendDrive = syncStatus?.backends?.drive || { enabled: null, hasError: false };
  const sections = [
    {
      title: "Daemon",
      rows: [
        ["Running", syncStatus?.running ? "Yes" : "No"],
        ["PID", syncStatus?.pid ?? "-"],
        ["Paused", syncStatus?.paused ? "Yes" : "No"],
        ["Status", syncStatus?.status || "idle"],
        ["Reason", syncStatus?.reason || "-"],
        ["Queued reason", syncStatus?.queuedReason || "-"],
        ["Conflicts", Number(syncStatus?.conflictCount || 0)]
      ]
    },
    {
      title: "Git",
      rows: [
        ["State", backendStatusLabel(backendGit)],
        [
          "Enabled",
          backendGit?.enabled === false ? "No" : backendGit?.enabled === true ? "Yes" : "Unknown"
        ],
        ["Reasons", (backendGit?.reasons || []).length ? backendGit.reasons.join(", ") : "-"],
        ["Last pull at", formatTimestamp(syncStatus?.lastPullAt)],
        ["Last push at", formatTimestamp(syncStatus?.lastPushAt)]
      ]
    },
    {
      title: "Google Drive",
      rows: [
        ["State", backendStatusLabel(backendDrive)],
        [
          "Enabled",
          backendDrive?.enabled === false
            ? "No"
            : backendDrive?.enabled === true
              ? "Yes"
              : "Unknown"
        ],
        ["Reasons", (backendDrive?.reasons || []).length ? backendDrive.reasons.join(", ") : "-"],
        ["Import", backendDrive?.gdriveImport || "-"],
        ["Review needed", backendDrive?.reviewNeeded ? "Yes" : "No"],
        ["Requires resync", backendDrive?.requiresResync ? "Yes" : "No"],
        [
          "Auto resync",
          backendDrive?.autoResyncAttempted
            ? backendDrive?.autoResyncApplied
              ? "Applied"
              : "Attempted"
            : "None"
        ]
      ]
    },
    {
      title: "Timestamps",
      rows: [
        ["Started at", formatTimestamp(syncStatus?.startedAt)],
        ["Finished at", formatTimestamp(syncStatus?.finishedAt)],
        ["Last success at", formatTimestamp(syncStatus?.lastSuccessAt)],
        ["Updated at", formatTimestamp(syncStatus?.updatedAt)],
        ["Last drive attempt at", formatTimestamp(syncStatus?.lastGDriveAttemptAt)],
        ["Last drive sync at", formatTimestamp(syncStatus?.lastGDriveSyncAt)],
        ["Last auto resync at", formatTimestamp(syncStatus?.lastGDriveAutoResyncAt)]
      ]
    }
  ];

  const snippetSections = [
    ["Alert", splitSnippet(syncStatus?.alert)],
    ["Sync error", splitSnippet(syncStatus?.lastError)],
    ["Git pull error", splitSnippet(backendGit?.lastPullError)],
    ["Git push error", splitSnippet(backendGit?.lastPushError)],
    ["Drive error", splitSnippet(backendDrive?.lastGDriveError)],
    ["Drive initial error", splitSnippet(backendDrive?.lastGDriveInitialError)],
    ["Drive output", splitSnippet(backendDrive?.lastGDriveOutput)]
  ].filter((entry) => entry[1].length);

  const lines = ["Refresh every 2s.", ""];
  for (const section of sections) {
    lines.push(`### ${section.title}`, "");
    lines.push(...buildMarkdownTable(["Field", "Value"], section.rows));
    lines.push("");
  }
  for (const [title, snippetLines] of snippetSections) {
    lines.push(`### ${title}`, "", "```text", ...snippetLines, "```", "");
  }
  lines.push("Usage : `/sync conflicts` | `/back` | `/conv`");
  return lines;
}

export function formatSearchScreenLines({ rebuilt, results }) {
  const rows = Array.isArray(results) ? results : [];
  const lines = [];
  if (rebuilt) {
    lines.push("Index rebuilt.", "");
  }
  if (!rows.length) {
    lines.push("No results.", "", "Usage : `/search <query>` | `/back` | `/conv`");
    return lines;
  }
  lines.push(
    ...buildMarkdownTable(
      ["#", "Path", "Score", "Snippet"],
      rows.map((result, index) => [
        String(index + 1),
        truncateText(result.filePath, 54),
        Number(result.score || 0).toFixed(4),
        truncateText(result.snippet || "-", 90)
      ])
    )
  );
  lines.push("", "Usage : `/search <query>` | `/back` | `/conv`");
  return lines;
}
