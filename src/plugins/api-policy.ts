/** Authentication and response handling only; API admission belongs to the backend. */
export interface OpenApiPolicyRule {
  product: string;
  actions: string[];
  auth: 'required' | 'optional';
  response?: 'success-code-envelope';
}

export function parsePluginApiPolicy(value: unknown): OpenApiPolicyRule[] {
  if (!Array.isArray(value)) throw new Error('apiPolicy must be an array');
  const pairs = new Map<string, string>();
  const rules: OpenApiPolicyRule[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
      throw new Error('apiPolicy rule must be an object');
    const rule = candidate as Record<string, unknown>;
    if (Object.keys(rule).some((key) => !['product', 'actions', 'auth', 'response'].includes(key)))
      throw new Error('unknown apiPolicy setting');
    if (
      typeof rule.product !== 'string' ||
      !rule.product.trim() ||
      !Array.isArray(rule.actions) ||
      !rule.actions.length ||
      rule.actions.some((action) => typeof action !== 'string' || !action.trim()) ||
      (rule.auth !== 'required' && rule.auth !== 'optional') ||
      (rule.response !== undefined && rule.response !== 'success-code-envelope')
    )
      throw new Error('invalid apiPolicy rule');
    const actions = [...new Set(rule.actions as string[])];
    const settings = JSON.stringify([rule.auth, rule.response ?? null]);
    let hasNewPair = false;
    for (const action of actions) {
      const pair = JSON.stringify([rule.product, action]);
      const previous = pairs.get(pair);
      if (previous !== undefined && previous !== settings)
        throw new Error(`conflicting apiPolicy for ${rule.product}/${action}`);
      hasNewPair ||= previous === undefined;
      pairs.set(pair, settings);
    }
    if (hasNewPair)
      rules.push({
        product: rule.product,
        actions,
        auth: rule.auth,
        ...(rule.response ? { response: rule.response } : {}),
      });
  }
  return rules;
}
