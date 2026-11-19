#!/usr/bin/env node
/**
 * Renders docs/INDEXER_API.md from indexer/openapi.yaml.
 *
 * The REST reference is generated, never edited by hand: `openapi.yaml` is
 * itself generated from the indexer's handlers and checked against them by a
 * Rust test, so this page cannot drift from the code. The one hand-written
 * part is the WebSocket section (docs/indexer-api/websocket.md), because
 * OpenAPI 3.1 has no way to describe a WebSocket route; it is appended
 * verbatim so the page reads as a single reference.
 *
 * Usage (from scripts/docs, after `npm ci`):
 *   node generate-indexer-api.mjs            write docs/INDEXER_API.md
 *   node generate-indexer-api.mjs --check    exit 1 if the committed page is stale
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const specPath = resolve(root, "indexer/openapi.yaml");
const websocketPath = resolve(root, "docs/indexer-api/websocket.md");
const outputPath = resolve(root, "docs/INDEXER_API.md");

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

// ── Formatting helpers ───────────────────────────────────────────────────────

/** Collapse text for a table cell: one line, pipes escaped. */
function cell(text) {
  if (text === undefined || text === null || text === "") return "";
  return String(text).trim().replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|");
}

function code(text) {
  return `\`${String(text).replace(/`/g, "")}\``;
}

function schemaLink(name) {
  return `[${name}](#schema-${name})`;
}

function refName(ref) {
  return ref.split("/").pop();
}

/** A human-readable type for a schema, linking named schemas. */
function typeOf(schema) {
  if (!schema) return "";
  if (schema.$ref) return schemaLink(refName(schema.$ref));

  if (schema.oneOf) return schema.oneOf.map(typeOf).join(" \\| ");
  if (schema.anyOf) return schema.anyOf.map(typeOf).join(" \\| ");
  if (schema.allOf) return schema.allOf.map(typeOf).join(" & ");

  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const rendered = types.map((type) => {
    if (type === "array") return `array of ${typeOf(schema.items) || "any"}`;
    if (type === "null") return "null";
    return schema.format ? `${type} (${schema.format})` : type;
  });
  let text = rendered.join(" \\| ");
  if (schema.enum && !schema.$ref) {
    text += ` — one of ${schema.enum.map((v) => code(v)).join(", ")}`;
  }
  if (schema.minimum !== undefined) text += `, min ${schema.minimum}`;
  if (schema.maximum !== undefined) text += `, max ${schema.maximum}`;
  return text || "object";
}

/** Rows of a property table for an object schema. */
function propertyTable(schema) {
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const names = Object.keys(properties);
  if (names.length === 0) return "";

  const lines = ["| Field | Type | Required | Description |", "|---|---|---|---|"];
  for (const name of names) {
    const prop = properties[name];
    lines.push(
      `| ${code(name)} | ${typeOf(prop)} | ${required.has(name) ? "yes" : "no"} | ${cell(prop.description)} |`,
    );
  }
  return lines.join("\n");
}

function paragraph(text) {
  return text ? `${String(text).trim()}\n` : "";
}

// ── Sections ─────────────────────────────────────────────────────────────────

function renderHeader(spec) {
  const servers = (spec.servers ?? []).map((s) => `${code(s.url)}${s.description ? ` — ${s.description}` : ""}`);
  return [
    "<!--",
    "  GENERATED FILE. Do not edit by hand.",
    "  Source: indexer/openapi.yaml (REST) and docs/indexer-api/websocket.md (WebSocket).",
    "  Regenerate: make docs-indexer-api",
    "-->",
    "",
    `# ${spec.info.title}`,
    "",
    paragraph(spec.info.description),
    `API version ${code(spec.info.version)}, OpenAPI ${code(spec.openapi)}.`,
    "",
    servers.length ? `Base path: ${servers.join("; ")}.` : "",
    "",
    "This reference is generated from [`indexer/openapi.yaml`](../indexer/openapi.yaml)",
    "during the docs build (`make docs`). That file is itself generated from the",
    "indexer's handlers and verified against them by a test, so each route and",
    "type below reflects the running code. The [WebSocket section](#websocket-event-stream)",
    "is the one hand-maintained part.",
    "",
  ].join("\n");
}

function collectOperations(spec) {
  const operations = [];
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      if (item[method]) operations.push({ path, method, op: item[method], shared: item.parameters ?? [] });
    }
  }
  operations.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  return operations;
}

function renderOverview(operations) {
  const lines = ["## Endpoints", "", "| Method | Path | Summary |", "|---|---|---|"];
  for (const { path, method, op } of operations) {
    lines.push(`| ${method.toUpperCase()} | ${code(path)} | ${cell(op.summary)} |`);
  }
  lines.push("| WebSocket | `/stream` | Live event subscription. See the [WebSocket section](#websocket-event-stream). |");
  lines.push("");
  return lines.join("\n");
}

function renderOperation({ path, method, op, shared }) {
  const lines = [`### ${method.toUpperCase()} ${path}`, ""];
  if (op.summary) lines.push(paragraph(op.summary));
  if (op.description) lines.push(paragraph(op.description));
  if (op.operationId) lines.push(`Operation ID: ${code(op.operationId)}`, "");

  const parameters = [...shared, ...(op.parameters ?? [])];
  if (parameters.length) {
    lines.push("**Parameters**", "", "| Name | In | Type | Required | Description |", "|---|---|---|---|---|");
    for (const p of parameters) {
      lines.push(
        `| ${code(p.name)} | ${p.in} | ${typeOf(p.schema)} | ${p.required ? "yes" : "no"} | ${cell(p.description)} |`,
      );
    }
    lines.push("");
  }

  const responses = Object.entries(op.responses ?? {});
  if (responses.length) {
    lines.push("**Responses**", "", "| Status | Description | Body |", "|---|---|---|");
    for (const [status, response] of responses) {
      const json = response.content?.["application/json"]?.schema;
      lines.push(`| ${status} | ${cell(response.description)} | ${json ? typeOf(json) : ""} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function renderSchema(name, schema) {
  const lines = [`<a id="schema-${name}"></a>`, "", `### ${name}`, ""];
  if (schema.description) lines.push(paragraph(schema.description));

  if (schema.oneOf) {
    lines.push("One of the following variants:", "");
    schema.oneOf.forEach((variant, index) => {
      const discriminator = variant.properties?.type?.enum?.[0];
      lines.push(`**${discriminator ? code(discriminator) : `Variant ${index + 1}`}**`, "");
      if (variant.description) lines.push(paragraph(variant.description));
      lines.push(propertyTable(variant) || typeOf(variant), "");
    });
    return lines.join("\n");
  }

  if (schema.enum) {
    lines.push(`Type: ${typeOf({ ...schema, enum: undefined })}. Allowed values:`, "");
    for (const value of schema.enum) lines.push(`- ${code(value)}`);
    lines.push("");
    return lines.join("\n");
  }

  const table = propertyTable(schema);
  if (table) {
    lines.push(table, "");
  } else {
    lines.push(`Type: ${typeOf(schema)}`, "");
  }
  return lines.join("\n");
}

// ── Assembly ─────────────────────────────────────────────────────────────────

export function render(spec, websocketMarkdown) {
  const operations = collectOperations(spec);
  const schemas = Object.entries(spec.components?.schemas ?? {}).sort(([a], [b]) => a.localeCompare(b));

  const parts = [
    renderHeader(spec),
    renderOverview(operations),
    "## REST routes",
    "",
    ...operations.map(renderOperation),
    "## Schemas",
    "",
    ...schemas.map(([name, schema]) => renderSchema(name, schema)),
    websocketMarkdown.trim(),
    "",
  ];

  // Collapse runs of blank lines so the output is stable regardless of which
  // optional sections were empty.
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]+$/gm, "");
}

function main() {
  const spec = parse(readFileSync(specPath, "utf8"));
  const websocket = readFileSync(websocketPath, "utf8");
  const output = render(spec, websocket);

  if (process.argv.includes("--check")) {
    let committed = "";
    try {
      committed = readFileSync(outputPath, "utf8");
    } catch {
      // Missing file counts as stale.
    }
    if (committed.replace(/\r\n/g, "\n") !== output) {
      console.error(
        "docs/INDEXER_API.md is stale relative to indexer/openapi.yaml or docs/indexer-api/websocket.md.\n" +
          "Run `make docs-indexer-api` and commit the result.",
      );
      process.exit(1);
    }
    console.log("docs/INDEXER_API.md is up to date.");
    return;
  }

  writeFileSync(outputPath, output, "utf8");
  console.log(`Wrote ${outputPath}`);
}

main();
