export type VisualFixtureType = 'app-dom' | 'replica' | 'raw-reference';

export const registryScenarioIds = {
  'message-actions': ['comp-message-actions'],
} as const;

export const replicaScenarios = new Set<string>([]);

export const rawReferenceScenarios = new Set<string>([]);

export const fixedDateByScenario: Record<string, string | undefined> = {
  'message-actions': undefined,
};

export function fixtureTypeForScenario(scenario: string): VisualFixtureType {
  if (rawReferenceScenarios.has(scenario)) return 'raw-reference';
  if (replicaScenarios.has(scenario)) return 'replica';
  return 'app-dom';
}

export function isKnownVisualScenario(scenario: string): boolean {
  return Object.prototype.hasOwnProperty.call(registryScenarioIds, scenario);
}
