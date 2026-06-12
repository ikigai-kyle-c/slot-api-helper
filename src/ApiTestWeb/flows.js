// =============================================================
// FLOW REGISTRY (auto-loader).
//
// To add a NEW flow: drop a file in ./flows/<name>.js exporting a
// flow definition (see ./flows/bet.js for the shape). It is picked
// up automatically — no edits here. Files starting with "_" are
// shared helpers, not flows.
//
// `order` controls tab order. Each flow file may use ./flows/_shared.js
// fragments but must NEVER require another flow (keep them decoupled).
// =============================================================
const fs = require('fs');
const path = require('path');
const { getByPath, launchToken, resolveExtract, applyExtract } = require('./flows/_shared');

const FLOWS_DIR = path.join(__dirname, 'flows');

const FLOWS = fs
  .readdirSync(FLOWS_DIR)
  .filter((f) => f.endsWith('.js') && !f.startsWith('_'))
  .map((f) => require(path.join(FLOWS_DIR, f)))
  .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));

const FLOW_MAP = Object.fromEntries(FLOWS.map((f) => [f.key, f]));

module.exports = { FLOWS, FLOW_MAP, getByPath, launchToken, resolveExtract, applyExtract };
