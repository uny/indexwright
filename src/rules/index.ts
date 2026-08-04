import type { Rule, RuleId } from '../types.js';
import { explicitNameField } from './explicit-name-field.js';
import { fieldOrderVariant } from './field-order-variant.js';
import { quotaHeadroom } from './quota-headroom.js';
import { scopeMismatch } from './scope-mismatch.js';

/**
 * Declaration order is R1 → R4 (SPEC §5), and it is also the sort order of findings within a file.
 */
export const rules: readonly Rule[] = [
  scopeMismatch,
  fieldOrderVariant,
  explicitNameField,
  quotaHeadroom,
];

const byId = new Map<RuleId, Rule>(rules.map((rule) => [rule.id, rule]));

export function getRule(id: RuleId): Rule {
  const rule = byId.get(id);
  if (!rule) throw new Error(`unknown rule: ${id}`);
  return rule;
}

export function isRuleId(value: string): value is RuleId {
  return byId.has(value as RuleId);
}

export { explicitNameField, fieldOrderVariant, quotaHeadroom, scopeMismatch };
