import type { AgWidgetDataFormat, AgWidgetFieldReference, AgWidgetFormParams, AgWidgetParams } from 'ag-studio';
import { AgIncompleteDataMappingOverlay, AgNoDataOverlay } from 'ag-studio-react';
import { useEffect, useState } from 'react';

/** The widget's saved state: which fields hold the agent, the money paid and the blocked attempts. */
export interface WatchlistWidget {
  type: 'agent-watchlist';
  dataMapping: {
    agent: AgWidgetFieldReference[];
    paid: AgWidgetFieldReference[];
    blocked: AgWidgetFieldReference[];
    aiBlocked: AgWidgetFieldReference[];
  };
  format?: AgWidgetDataFormat<Record<string, never>>;
}

type Row = Record<string, unknown>;
// Inside a widget, Studio hands each mapped field over resolved: with the key its rows are read by.
type ResolvedField = AgWidgetFieldReference & { key: string };

/**
 * A custom AG Studio widget: one card per agent with what it paid and what Allowance stopped (blocked, or held and then
 * denied), agents with stopped attempts first. A click cross-filters the whole dashboard to that agent.
 */
export function AgentWatchlist({ widgetApi, dataMapping }: AgWidgetParams<WatchlistWidget>) {
  const [agent, paid, blocked, ai] = (['agent', 'paid', 'blocked', 'aiBlocked'] as const).map(
    (key) => (dataMapping[key] as unknown as ResolvedField[] | undefined)?.[0],
  );
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => {
    if (!agent || !paid || !blocked) return;
    let alive = true;
    const fields = [agent, paid, blocked, ...(ai ? [ai] : [])] as unknown as Parameters<typeof widgetApi.getData>[0]['fields'];
    // onDataUpdated keeps the cards live as new requests reach the ledger.
    widgetApi
      .getData({ fields }, { onDataUpdated: (response) => alive && setRows(response.results.rows) })
      .then((response) => alive && setRows(response.results.rows))
      .catch(() => alive && setRows([]));
    return () => {
      alive = false;
    };
  }, [widgetApi, agent, paid, blocked, ai]);

  if (!agent || !paid || !blocked) return <AgIncompleteDataMappingOverlay />;
  if (rows === null) return null;
  if (!rows.length) return <AgNoDataOverlay />;

  const number = (row: Row, field: ResolvedField | undefined) => (field ? Number(row[field.key] ?? 0) : 0);
  const sorted = [...rows].sort((a, b) => number(b, blocked) - number(a, blocked) || number(b, paid) - number(a, paid));
  const picked = new Set(widgetApi.getCrossFilterSelections()?.flatMap((selection) => ('values' in selection ? selection.values : [])) ?? []);
  const format = (field: ResolvedField, value: unknown) => widgetApi.formatFieldValue(field as never, value);

  return (
    <div className="watchlist">
      {sorted.map((row) => {
        const name = row[agent.key];
        const blockedCount = number(row, blocked);
        const byAi = number(row, ai);
        return (
          <button
            key={String(name)}
            type="button"
            className={`watch ${blockedCount ? 'flagged' : ''} ${picked.has(name) ? 'on' : ''}`}
            onClick={(event) =>
              widgetApi.toggleCrossFilter({ type: 'value', field: agent as never, value: name, group: 0, reset: !(event.ctrlKey || event.metaKey) })
            }
          >
            <span className="who">{format(agent, name)}</span>
            <span className="paid">{format(paid, number(row, paid))} paid</span>
            <span className={`blocked ${blockedCount ? 'bad' : ''}`}>
              {blockedCount
                ? `${blockedCount} stopped${byAi ? (byAi === blockedCount ? ', caught by the AI review' : `, ${byAi} caught by the AI review`) : ''}`
                : 'nothing stopped'}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** The edit panel for the widget: Studio's standard data-mapping form, with Allowance's labels. */
export function watchlistForm(params: AgWidgetFormParams<WatchlistWidget>) {
  return params.createDefaults({
    dataMappingItems: [
      { key: 'agent', label: 'Agent' },
      { key: 'paid', label: 'Money paid' },
      { key: 'blocked', label: 'Stopped attempts' },
      { key: 'aiBlocked', label: 'Caught by the AI review' },
    ],
  });
}
