/**
 * Writer Worldbuilding — behavior simulation → emergent plot
 *
 * Current provider: AI-powered simulation via streamChat (LiteLLM / direct).
 * Future provider: MiroFish Docker service (AGPL — must run as separate process).
 *
 * @module writer/worldbuilding
 */
import { Hono } from 'hono';
import { getUser } from '../middleware/auth';
import { checkBilling } from '../middleware/billing-guard';
import { streamChat, type ChatMessage, type StreamChunk } from '../services/ai-router';
import {
  isMiroSharkEnabled,
  miroSharkExtract,
  miroSharkSimulate,
  miroSharkGenerateScenes,
} from './worldbuilding-mirofish';

export const worldbuildingRoutes = new Hono();

// Use groq as default — it is the most reliably available provider on this server.
const DEFAULT_MODEL = 'groq/llama-3.3-70b-versatile';

// ── Types ────────────────────────────────────────────────────────────────────

interface Character {
  name: string;
  role: string;
  personality: string;
  motivations: string[];
  relationships: Array<{ target: string; type: string; description: string }>;
}

interface Location {
  name: string;
  description: string;
  significance: string;
  connected_locations: string[];
}

interface WorldEntities {
  characters: Character[];
  locations: Location[];
  rules: string[];
  factions: Array<{ name: string; goals: string; members: string[] }>;
  timeline: Array<{ period: string; event: string }>;
}

interface SimulationEvent {
  timestamp: string;
  character: string;
  action: string;
  consequence: string;
  emotional_state: string;
}

interface PlotPoint {
  title: string;
  description: string;
  tension_level: number;
  characters_involved: string[];
  type: 'inciting_incident' | 'rising_action' | 'climax' | 'falling_action' | 'resolution' | 'subplot';
}

interface SimulationResult {
  events: SimulationEvent[];
  plot_points: PlotPoint[];
  world_state_changes: string[];
}

interface Contradiction {
  character: string;
  issue: string;
  severity: 'info' | 'warn' | 'error';
}

interface SceneOutline {
  scene_number: number;
  location: string;
  characters: string[];
  time_of_day: string;
  action: string;
  dialogue_notes: string;
  camera_notes: string;
  emotional_arc: string;
}

// ── Utility: Collect stream into string ──────────────────────────────────────

async function collectStream(gen: AsyncGenerator<StreamChunk>): Promise<string> {
  let text = '';
  for await (const chunk of gen) {
    if (chunk.type === 'text') {
      text += chunk.content || '';
    }
    if (chunk.type === 'error') throw new Error(chunk.content);
  }
  return text;
}

function parseJSONFromAI<T>(raw: string): T {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch { /* fall through */ }

  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim()) as T;
    } catch { /* fall through */ }
  }

  const startIdx = trimmed.search(/[\[{]/);
  if (startIdx === -1) throw new Error('No JSON object found in AI response');

  const opener = trimmed[startIdx];
  const closer = opener === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIdx; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === opener) depth++;
    if (ch === closer) depth--;
    if (depth === 0) {
      return JSON.parse(trimmed.slice(startIdx, i + 1)) as T;
    }
  }

  throw new Error('Malformed JSON in AI response — unbalanced brackets');
}

// ── Swappable Provider: Entity Extraction ────────────────────────────────────

const EXTRACT_SYSTEM_PROMPT = `You are an expert worldbuilder. Analyze the text and extract entities into JSON.
Output ONLY JSON:
{
  "characters": [{"name": "...", "role": "...", "personality": "...", "motivations": ["..."], "relationships": [{"target": "...", "type": "...", "description": "..."}]}],
  "locations": [{"name": "...", "description": "...", "significance": "...", "connected_locations": ["..."]}],
  "rules": ["..."],
  "factions": [{"name": "...", "goals": "...", "members": ["..."]}],
  "timeline": [{"period": "...", "event": "..."}]
}`;

async function extractEntities(
  universeBible: string,
  model = DEFAULT_MODEL,
): Promise<WorldEntities> {
  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: `Extract all entities from this text:\n\n${universeBible}\n\nReturn ONLY JSON.`,
    },
  ];

  const gen = streamChat(messages, model, undefined, {
    systemPrompt: EXTRACT_SYSTEM_PROMPT,
    temperature: 0.2,
  });

  const raw = await collectStream(gen);
  return parseJSONFromAI<WorldEntities>(raw);
}

/** Merge multiple WorldEntities objects, removing duplicates by name */
function mergeEntities(results: WorldEntities[]): WorldEntities {
  const merged: WorldEntities = {
    characters: [],
    locations: [],
    rules: [],
    factions: [],
    timeline: [],
  };

  const charMap = new Map<string, Character>();
  const locMap = new Map<string, Location>();
  const factionMap = new Map<string, any>();
  const ruleSet = new Set<string>();

  for (const res of results) {
    res.characters.forEach(c => {
      if (!charMap.has(c.name)) charMap.set(c.name, c);
      else {
        // Merge motivations and relationships
        const existing = charMap.get(c.name)!;
        existing.motivations = [...new Set([...existing.motivations, ...c.motivations])];
        existing.relationships = [...existing.relationships, ...c.relationships.filter(r => 
          !existing.relationships.some(er => er.target === r.target && er.type === r.type)
        )];
      }
    });

    res.locations.forEach(l => {
      if (!locMap.has(l.name)) locMap.set(l.name, l);
    });

    res.factions.forEach(f => {
      if (!factionMap.has(f.name)) factionMap.set(f.name, f);
      else {
        const existing = factionMap.get(f.name)!;
        existing.members = [...new Set([...existing.members, ...f.members])];
      }
    });

    res.rules.forEach(r => ruleSet.add(r));
    merged.timeline.push(...res.timeline);
  }

  merged.characters = Array.from(charMap.values());
  merged.locations = Array.from(locMap.values());
  merged.factions = Array.from(factionMap.values());
  merged.rules = Array.from(ruleSet);
  // Sort timeline if possible, otherwise keep order
  return merged;
}

// ── Swappable Provider: Behavior Simulation ──────────────────────────────────

async function simulateScenario(
  entities: WorldEntities,
  scenario: string,
  model = DEFAULT_MODEL,
): Promise<SimulationResult> {
  const entitySummary = JSON.stringify(entities);
  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: `World State: ${entitySummary}\n\nScenario: ${scenario}\n\nSimulate reactions. Return ONLY JSON.`,
    },
  ];

  const gen = streamChat(messages, model, undefined, {
    systemPrompt: `You are a behavioral simulation engine. Return ONLY valid JSON:
{
  "events": [{"timestamp": "...", "character": "...", "action": "...", "consequence": "...", "emotional_state": "..."}],
  "plot_points": [{"title": "...", "description": "...", "tension_level": 1-10, "characters_involved": ["..."], "type": "rising_action"}],
  "world_state_changes": ["..."]
}`,
    temperature: 0.6,
  });

  const raw = await collectStream(gen);
  return parseJSONFromAI<SimulationResult>(raw);
}

// ── Route 1: POST /worldbuilding/extract ─────────────────────────────────────

worldbuildingRoutes.post('/worldbuilding/extract', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  let body: { universe_bible?: string; model?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const universeBible = body.universe_bible?.trim();
  if (!universeBible) return c.json({ error: 'universe_bible is required' }, 400);
  
  const model = body.model || DEFAULT_MODEL;
  const billing = await checkBilling(user.id, model);
  if (!billing.allowed) return c.json({ error: billing.error, code: billing.code }, 402);

  try {
    // Chunking for large documents
    if (universeBible.length > 12000) {
      const CHUNK_SIZE = 10000;
      const OVERLAP = 1000;
      const chunks: string[] = [];
      for (let i = 0; i < universeBible.length; i += (CHUNK_SIZE - OVERLAP)) {
        chunks.push(universeBible.slice(i, i + CHUNK_SIZE));
        if (i + CHUNK_SIZE >= universeBible.length) break;
      }

      const results = await Promise.all(chunks.map(chunk => extractEntities(chunk, model)));
      const merged = mergeEntities(results);
      return c.json({ entities: merged, meta: { chunked: true, chunks: chunks.length } });
    }

    const entities = await extractEntities(universeBible, model);
    return c.json({ entities });
  } catch (err: any) {
    console.error('[worldbuilding/extract] Error:', err);
    return c.json({ error: 'Entity extraction failed', detail: err.message }, 502);
  }
});

// ── Route 2: POST /worldbuilding/simulate ────────────────────────────────────

worldbuildingRoutes.post('/worldbuilding/simulate', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  let body: { entities?: WorldEntities; scenario?: string; model?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { entities, scenario } = body;
  if (!entities || !scenario) return c.json({ error: 'entities and scenario required' }, 400);

  const model = body.model || DEFAULT_MODEL;
  const billing = await checkBilling(user.id, model);
  if (!billing.allowed) return c.json({ error: billing.error, code: billing.code }, 402);

  try {
    const result = await simulateScenario(entities, scenario.trim(), model);
    return c.json({ simulation: result });
  } catch (err: any) {
    console.error('[worldbuilding/simulate] Error:', err);
    return c.json({ error: 'Simulation failed', detail: err.message }, 502);
  }
});

// ── Route 3: POST /worldbuilding/check ───────────────────────────────────────

worldbuildingRoutes.post('/worldbuilding/check', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  let body: { bibleText?: string; selection?: string; model?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { bibleText, selection } = body;
  if (!bibleText || !selection) return c.json({ error: 'bibleText and selection required' }, 400);

  const model = body.model || DEFAULT_MODEL;
  const billing = await checkBilling(user.id, model);
  if (!billing.allowed) return c.json({ error: billing.error, code: billing.code }, 402);

  try {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: `Story Bible:\n${bibleText}\n\nCurrent Text Selection:\n${selection}\n\nCheck for contradictions between the selection and the bible. Return ONLY JSON: { "contradictions": [{"character": "...", "issue": "...", "severity": "error|warn|info"}] }`,
      },
    ];

    const gen = streamChat(messages, model, undefined, {
      systemPrompt: 'You are a narrative consistency auditor. Identify direct contradictions between the story bible and the text.',
      temperature: 0.1,
    });

    const raw = await collectStream(gen);
    const result = parseJSONFromAI<{ contradictions: Contradiction[] }>(raw);
    return c.json(result);
  } catch (err: any) {
    console.error('[worldbuilding/check] Error:', err);
    return c.json({ error: 'Consistency check failed', detail: err.message }, 502);
  }
});
