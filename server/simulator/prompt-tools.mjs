import { readFileSync } from 'node:fs';

export function readPromptBody(path) {
  const source = readFileSync(path, 'utf8');
  const marker = '\n---\n\n';
  const index = source.indexOf(marker);
  if (index < 0) throw Error('prompt_body_marker_missing');
  return source.slice(index + marker.length).trim();
}

export function replaceAgentPrompt(config, prompt) {
  const copy = structuredClone(config);
  if (!copy?.agent?.prompt || typeof copy.agent.prompt !== 'object') throw Error('agent_prompt_missing');
  copy.agent.prompt.prompt = prompt;
  return copy;
}

export function minimalPromptUpdateAllowed({ currentPrompt, publishedPrompt, targetPrompt }) {
  const canonical = value => String(value || '').replace(/\s+/g, ' ').trim();
  if (canonical(currentPrompt) === canonical(targetPrompt)) return 'already_current';
  if (canonical(currentPrompt) === canonical(publishedPrompt)) return 'update_only';
  return 'unexpected_current_prompt';
}

const normalizePrompt = value => String(value || '').replace(/\s+/g, ' ').trim();
const words = value => normalizePrompt(value).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];

// Similarity is diagnostic only. It never authorizes an update.
export function classifyRemotePrompt(current, v2, v3) {
  const prompt = normalizePrompt(current);
  const v2n = normalizePrompt(v2);
  const v3n = normalizePrompt(v3);
  if (prompt === v3n) return { classification: 'already_v3', basis: 'whitespace-normalized exact match' };
  if (prompt === v2n) return { classification: 'exact_v2', basis: 'whitespace-normalized exact match' };
  const actual = new Set(words(prompt));
  const score = candidate => {
    const tokens = new Set(words(candidate));
    if (!actual.size || !tokens.size) return 0;
    let shared = 0;
    for (const token of actual) if (tokens.has(token)) shared += 1;
    return shared / (actual.size + tokens.size - shared);
  };
  const v2Score = score(v2n);
  const v3Score = score(v3n);
  // Only a strong lexical match to v2 is labeled as a modified v2; this is a hint, not proof.
  if (v2Score >= 0.72 && v2Score >= v3Score) {
    return { classification: 'modified_v2', basis: 'heuristic lexical match', v2Similarity: v2Score, v3Similarity: v3Score };
  }
  return { classification: 'different_version', basis: 'no exact local match', v2Similarity: v2Score, v3Similarity: v3Score };
}

export function promptLineDiff(left, right) {
  const a = String(left || '').replace(/\r\n/g, '\n').split('\n').map(s => s.trim()).filter(Boolean);
  const b = String(right || '').replace(/\r\n/g, '\n').split('\n').map(s => s.trim()).filter(Boolean);
  const as = new Set(a);
  const bs = new Set(b);
  return {
    onlyRemote: a.filter(line => !bs.has(line)),
    onlyLocal: b.filter(line => !as.has(line)),
  };
}
