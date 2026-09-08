/** The devnet committee: the five operators holding the key shares.
 *
 * Named the way institutions are named, so a share log reads like a roster.
 * One list, read by every surface that shows an operator, so a change here
 * lands everywhere at once.
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
export const DEVNET_RING_NOTE = 'the five operators holding the committee\'s key shares';
