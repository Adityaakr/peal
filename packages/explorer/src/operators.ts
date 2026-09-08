/** The devnet committee: names for the five operators we run.
 *
 * Named the way the institutions that will one day hold these keys are named,
 * so a share log reads like a roster and not like a process list. They are
 * ours. No organisation by any of these names operates a node, holds a key, or
 * has agreed to; all five run on infrastructure we control, from one
 * deployment, and every page that shows a name says so beside it. When
 * independent operators exist, their real names replace these, here, once.
 *
 * Operator ids on the wire (1..5, `party_index` in the coordinator) map onto
 * them in order. `short` is what fits under a number in the committee widget;
 * `name` is what prose and the share log use.
 */

export interface Operator {
  /** The wire id, `operator_id` on shares and `party_index` in the crypto. */
  id: number;
  name: string;
  short: string;
}

export const DEVNET_OPERATORS: readonly Operator[] = [
  { id: 1, name: 'Meridian Assay', short: 'meridian' },
  { id: 2, name: 'Halcyon Registry', short: 'halcyon' },
  { id: 3, name: 'Northwind Trust', short: 'northwind' },
  { id: 4, name: 'Ardent Notary', short: 'ardent' },
  { id: 5, name: 'Vantage Archive', short: 'vantage' },
];

/** The name for a wire id, or the id itself for one outside the roster. */
export function operatorName(id: number): string {
  return DEVNET_OPERATORS.find((o) => o.id === id)?.name ?? `operator ${id}`;
}

/** "Meridian Assay, Halcyon Registry, ... and Vantage Archive", for prose. */
export const DEVNET_RING = `${DEVNET_OPERATORS.slice(0, -1).map((o) => o.name).join(', ')} and ${DEVNET_OPERATORS[DEVNET_OPERATORS.length - 1]!.name}`;

/** The sentence that has to travel with the names wherever they appear. */
export const DEVNET_RING_NOTE =
  'five names we chose for five processes we run; no organisation by those names operates a node';
