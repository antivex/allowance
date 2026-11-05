import type { AgWidgetDataFormat, AgWidgetFieldReference, AgWidgetFormParams, AgWidgetParams } from 'ag-studio';
import { AgIncompleteDataMappingOverlay, AgNoDataOverlay } from 'ag-studio-react';
import { useEffect, useState, type MouseEvent } from 'react';

/** The widget's saved state: what the rules said, where the money ended up, who decided, and how much. */
export interface DecisionFlowWidget {
  type: 'decision-flow';
  dataMapping: {
    rules: AgWidgetFieldReference[];
    outcome: AgWidgetFieldReference[];
    decider: AgWidgetFieldReference[];
    amount: AgWidgetFieldReference[];
  };
  format?: AgWidgetDataFormat<Record<string, never>>;
}

type Row = Record<string, unknown>;
type ResolvedField = AgWidgetFieldReference & { key: string };

/** Left column: what the fixed rules alone would have done. Right column: what happened to the money. */
const RULES_ORDER = ['Pay at once', 'Ask the owner', 'Block'];
const OUTCOME_ORDER = ['Paid', 'Held for the owner', 'Denied by the owner', 'Expired', 'Blocked', 'Failed', 'Processing'];
const OUTCOME_COLOR: Record<string, string> = {
  Paid: '#43d391',
  'Held for the owner': '#f3c15a',
  'Denied by the owner': '#8d96a8',
  Expired: '#8d96a8',
  Blocked: '#ff7d7d',
  Failed: '#ff7d7d',
  Processing: '#7b93ff',
};
const AI = 'AI review';

const W = 1000;
const H = 340;
const NODE = 14;
const GAP = 18;
const TOP = 24;
const LEFT_X = 210;
const RIGHT_X = W - 230;

interface Node {
  name: string;
  total: number;
  y: number;
  height: number;
  /** Where the next band leaves or arrives on this node. */
  cursor: number;
}

function layout(names: string[], totals: Map<string, number>, scale: number): Map<string, Node> {
  const nodes = new Map<string, Node>();
  let y = TOP;
  for (const name of names) {
    const total = totals.get(name) ?? 0;
    if (total <= 0) continue;
    const height = Math.max(total * scale, 3);
    nodes.set(name, { name, total, y, height, cursor: y });
    y += height + GAP;
  }
  return nodes;
}

/**
 * A custom AG Studio widget: the money every agent asked for, from what the fixed rules alone would have done to where
 * it ended up. Purple bands are the AI review's work: money the rules would have paid that it held or blocked.
 * A click on an outcome cross-filters the whole page to it.
 */
export function DecisionFlow({ widgetApi, dataMapping }: AgWidgetParams<DecisionFlowWidget>) {
  const [rules, outcome, decider, amount] = (['rules', 'outcome', 'decider', 'amount'] as const).map(
    (key) => (dataMapping[key] as unknown as ResolvedField[] | undefined)?.[0],
  );
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => {
    if (!rules || !outcome || !decider || !amount) return;
    let alive = true;
    const fields = [rules, outcome, decider, amount] as unknown as Parameters<typeof widgetApi.getData>[0]['fields'];
    widgetApi
      .getData({ fields }, { onDataUpdated: (response) => alive && setRows(response.results.rows) })
      .then((response) => alive && setRows(response.results.rows))
      .catch(() => alive && setRows([]));
    return () => {
      alive = false;
    };
  }, [widgetApi, rules, outcome, decider, amount]);

  if (!rules || !outcome || !decider || !amount) return <AgIncompleteDataMappingOverlay />;
  if (rows === null) return null;
  const flows = rows
    .map((row) => ({
      from: String(row[rules.key] ?? ''),
      to: String(row[outcome.key] ?? ''),
      ai: String(row[decider.key] ?? '') === AI,
      value: Number(row[amount.key] ?? 0),
    }))
    .filter((flow) => flow.value > 0);
  if (!flows.length) return <AgNoDataOverlay />;

  const sum = (pick: (flow: (typeof flows)[number]) => string) => {
    const totals = new Map<string, number>();
    for (const flow of flows) totals.set(pick(flow), (totals.get(pick(flow)) ?? 0) + flow.value);
    return totals;
  };
  const leftTotals = sum((flow) => flow.from);
  const rightTotals = sum((flow) => flow.to);
  const leftNames = [...RULES_ORDER, ...[...leftTotals.keys()].filter((name) => !RULES_ORDER.includes(name))];
  const rightNames = [...OUTCOME_ORDER, ...[...rightTotals.keys()].filter((name) => !OUTCOME_ORDER.includes(name))];
  const total = flows.reduce((all, flow) => all + flow.value, 0);
  const gaps = Math.max(leftTotals.size, rightTotals.size) - 1;
  const scale = (H - TOP - 30 - gaps * GAP) / total;
  const left = layout(leftNames, leftTotals, scale);
  const right = layout(rightNames, rightTotals, scale);
  const money = (value: number) => widgetApi.formatFieldValue(amount as never, value);
  const picked = new Set(widgetApi.getCrossFilterSelections()?.flatMap((selection) => ('values' in selection ? selection.values : [])) ?? []);
  const select = (field: ResolvedField, value: string, event: MouseEvent) =>
    widgetApi.toggleCrossFilter({ type: 'value', field: field as never, value, group: 0, reset: !(event.ctrlKey || event.metaKey) });

  // Each node stacks its bands in the order of their other ends, so bands do not cross where they need not;
  // within the same pair, the rules' money comes before the AI review's.
  const thickness = (flow: (typeof flows)[number]) => Math.max(flow.value * scale, 1.5);
  const start = new Map<(typeof flows)[number], number>();
  const end = new Map<(typeof flows)[number], number>();
  for (const node of left.values()) {
    const outgoing = flows.filter((flow) => flow.from === node.name);
    outgoing.sort((a, b) => rightNames.indexOf(a.to) - rightNames.indexOf(b.to) || Number(a.ai) - Number(b.ai));
    for (const flow of outgoing) {
      start.set(flow, node.cursor + thickness(flow) / 2);
      node.cursor += thickness(flow);
    }
  }
  for (const node of right.values()) {
    const incoming = flows.filter((flow) => flow.to === node.name);
    incoming.sort((a, b) => leftNames.indexOf(a.from) - leftNames.indexOf(b.from) || Number(a.ai) - Number(b.ai));
    for (const flow of incoming) {
      end.set(flow, node.cursor + thickness(flow) / 2);
      node.cursor += thickness(flow);
    }
  }
  const x0 = LEFT_X + NODE;
  const x1 = RIGHT_X;
  const mid = (x0 + x1) / 2;
  const bands = flows.map((flow) => {
    const y0 = start.get(flow)!;
    const y1 = end.get(flow)!;
    return { flow, height: thickness(flow), d: `M${x0},${y0} C${mid},${y0} ${mid},${y1} ${x1},${y1}` };
  });

  return (
    <div className="flow">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Where the money went, from what the rules said to what happened">
        <text className="flow-head" x={LEFT_X + NODE / 2} y={12} textAnchor="middle">
          The rules alone would
        </text>
        <text className="flow-head" x={RIGHT_X + NODE / 2} y={12} textAnchor="middle">
          What happened
        </text>
        {bands.map(({ flow, height, d }, index) => (
          <path key={index} d={d} className={`flow-band ${flow.ai ? 'ai' : ''}`} strokeWidth={height}>
            <title>
              {`${flow.from} → ${flow.to}: ${money(flow.value)}${flow.ai ? ', decided by the AI review' : ''}`}
            </title>
          </path>
        ))}
        {[...left.values()].map((node) => (
          <g key={node.name} className={`flow-node ${picked.has(node.name) ? 'on' : ''}`} onClick={(event) => select(rules, node.name, event)}>
            <rect x={LEFT_X} y={node.y} width={NODE} height={node.height} rx={3} className="flow-rules" />
            <text x={LEFT_X - 10} y={node.y + node.height / 2} textAnchor="end" dominantBaseline="middle">
              <tspan className="flow-name">{node.name}</tspan>
              <tspan className="flow-money" dx={8}>
                {money(node.total)}
              </tspan>
            </text>
          </g>
        ))}
        {[...right.values()].map((node) => (
          <g key={node.name} className={`flow-node ${picked.has(node.name) ? 'on' : ''}`} onClick={(event) => select(outcome, node.name, event)}>
            <rect x={RIGHT_X} y={node.y} width={NODE} height={node.height} rx={3} fill={OUTCOME_COLOR[node.name] ?? '#7b93ff'} />
            <text x={RIGHT_X + NODE + 10} y={node.y + node.height / 2} dominantBaseline="middle">
              <tspan className="flow-name">{node.name}</tspan>
              <tspan className="flow-money" dx={8}>
                {money(node.total)}
              </tspan>
            </text>
          </g>
        ))}
        <g className="flow-legend" transform={`translate(${LEFT_X}, ${H - 8})`}>
          <rect x={0} y={-9} width={22} height={9} rx={2} className="flow-key" />
          <text x={30} y={0}>
            decided by the rules (or by you)
          </text>
          <rect x={290} y={-9} width={22} height={9} rx={2} className="flow-key ai" />
          <text x={320} y={0}>
            made stricter by the AI review
          </text>
        </g>
      </svg>
    </div>
  );
}

/** The edit panel for the widget: Studio's standard data-mapping form, with Allowance's labels. */
export function decisionFlowForm(params: AgWidgetFormParams<DecisionFlowWidget>) {
  return params.createDefaults({
    dataMappingItems: [
      { key: 'rules', label: 'What the rules said' },
      { key: 'outcome', label: 'What happened' },
      { key: 'decider', label: 'Who decided' },
      { key: 'amount', label: 'Money' },
    ],
  });
}
