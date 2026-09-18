import type {ActionCategory} from '../../shared/types';

/**
 * The seam between Grace deciding to do something and it actually happening.
 *
 * Every real-world action goes through here, which is what makes the
 * confirmation policy structural rather than a paragraph in a prompt. A model
 * can be talked out of an instruction; it cannot be talked past a function
 * that refuses to run.
 */

export interface ToolParameter {
  type: 'string' | 'number' | 'boolean';
  description: string;
  /** Fixed set of allowed values, where one applies. */
  values?: string[];
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  required: string[];
  /** Which confirmation policy governs this. */
  category: ActionCategory;
  /**
   * True when the effect cannot be taken back.
   *
   * Deleting, cancelling, and anything involving other people. The user's
   * standing instruction is that nothing is ever deleted, so no tool here is
   * allowed to be destructive at all — this exists so the guard can prove it.
   */
  destructive?: boolean;
  /**
   * Whether this particular call is the destructive kind.
   *
   * `destructive` is a property of the tool; this is a property of the
   * request. One shell is both "list that folder" and "delete that folder",
   * and a gate that cannot tell the two apart has to choose between asking
   * about everything and asking about nothing. Both are wrong: the first
   * trains the user to say yes without reading, which is worse than no gate.
   */
  risky?: (args: Record<string, unknown>) => boolean;
  run: (args: Record<string, unknown>) => Promise<string>;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ToolOutcome {
  name: string;
  /** What to hand back to the model. Plain words, since it reads them. */
  result: string;
  /** Shown to the user, so an action is never invisible. */
  summary: string;
  ok: boolean;
}
