import type {ActionCategory, ActionPolicy, ConfirmationPolicy} from '../shared/types';
import {Document} from './store/index';

/**
 * The user's two hard limits are enforced here rather than only in the prompt.
 * A model can be talked out of an instruction; this layer cannot.
 */
const DEFAULT_POLICIES: ActionPolicy[] = [
  {category: 'communication', policy: 'always', locked: true},
  {category: 'purchase', policy: 'always', locked: true},
  {category: 'security', policy: 'always'},
  {category: 'calendar', policy: 'high-risk'},
  {category: 'home', policy: 'high-risk'},
  {category: 'research', policy: 'never'},
];

const store = new Document<ActionPolicy[]>('policies', () => DEFAULT_POLICIES);

export function getPolicies(): Promise<ActionPolicy[]> {
  return store.read();
}

export async function policyFor(category: ActionCategory): Promise<ConfirmationPolicy> {
  const policies = await store.read();
  return policies.find((entry) => entry.category === category)?.policy ?? 'always';
}

/**
 * Locked categories reject changes outright — including changes Grace herself
 * proposes, which is the point.
 */
export async function setPolicy(
  category: ActionCategory,
  policy: ConfirmationPolicy,
): Promise<{ok: boolean; reason?: string}> {
  const current = await store.read();
  const existing = current.find((entry) => entry.category === category);

  if (!existing) {
    return {ok: false, reason: `unknown action category "${category}"`};
  }

  if (existing.locked) {
    return {
      ok: false,
      reason: `"${category}" is a hard limit you set and cannot be relaxed here`,
    };
  }

  await store.write(
    current.map((entry) =>
      entry.category === category ? {...entry, policy} : entry,
    ),
  );

  return {ok: true};
}

/**
 * Every real-world action in later phases routes through this before running.
 * Returns whether the action needs sign-off before it may proceed.
 */
export async function requiresConfirmation(
  category: ActionCategory,
  highRisk = false,
): Promise<boolean> {
  const policy = await policyFor(category);
  if (policy === 'always') return true;
  if (policy === 'never') return false;
  return highRisk;
}
