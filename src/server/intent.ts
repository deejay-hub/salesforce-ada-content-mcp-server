// Lightweight intent classification — adjusts ranking signals based on what the user is asking for.
// Regex-based (no ML overhead); first match wins, falls back to "conceptual".

export type QueryIntent = "conceptual" | "implementation" | "troubleshooting" | "reference";

export interface IntentProfile {
  intent: QueryIntent;
  preferLongContent: boolean;
  boostCode: boolean;
  extraRecencyMultiplier: number;
  extraExactMatchMultiplier: number;
}

const PATTERNS: [QueryIntent, RegExp][] = [
  ["troubleshooting", /\b(error|exception|fail|fix|not working|issue|bug|troubleshoot|debug|resolve|broken)\b/i],
  ["implementation", /\b(how to|how do|example|configure|set up|setup|implement|create|build|step|code|deploy|install|write|add)\b/i],
  ["reference", /\b(api|method|parameter|param|limit|syntax|signature|endpoint|field|property|return type|governor)\b/i],
];

const PROFILES: Record<QueryIntent, IntentProfile> = {
  troubleshooting: { intent: "troubleshooting", preferLongContent: false, boostCode: false, extraRecencyMultiplier: 1.5, extraExactMatchMultiplier: 1.0 },
  implementation: { intent: "implementation", preferLongContent: false, boostCode: true, extraRecencyMultiplier: 1.0, extraExactMatchMultiplier: 1.0 },
  reference: { intent: "reference", preferLongContent: false, boostCode: false, extraRecencyMultiplier: 1.0, extraExactMatchMultiplier: 1.5 },
  conceptual: { intent: "conceptual", preferLongContent: true, boostCode: false, extraRecencyMultiplier: 1.0, extraExactMatchMultiplier: 1.0 },
};

export function detectIntent(query: string): IntentProfile {
  for (const [intent, pattern] of PATTERNS) {
    if (pattern.test(query)) return PROFILES[intent];
  }
  return PROFILES.conceptual;
}
