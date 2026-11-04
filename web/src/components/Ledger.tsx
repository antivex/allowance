import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type ColDef,
  type GetRowIdParams,
  type GridApi,
  type ICellRendererParams,
  type IRowNode,
  type RowClassRules,
} from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatMoney, formatTime, shortId, timeLeft } from '../format';
import type { Purchase, PurchaseStatus } from '../types';
import { SourceTag, Spinner, StatusPill } from './ui';

ModuleRegistry.registerModules([AllCommunityModule]);

/** The grid follows the page's CSS variables, so light and dark mode need no second theme. */
const gridTheme = themeQuartz.withParams({
  browserColorScheme: 'inherit',
  fontFamily: 'inherit',
  fontSize: 13.5,
  backgroundColor: 'var(--surface)',
  foregroundColor: 'var(--text)',
  headerBackgroundColor: 'var(--surface)',
  headerTextColor: 'var(--muted)',
  headerFontSize: 12,
  headerFontWeight: 600,
  borderColor: 'var(--border)',
  accentColor: 'var(--brand)',
  oddRowBackgroundColor: 'var(--surface)',
  wrapperBorder: false,
  wrapperBorderRadius: 0,
  rowHeight: 58,
  headerHeight: 42,
  cellHorizontalPadding: 14,
  spacing: 7,
});

/** Below this grid width the Agent column hides, so Why and the buttons never scroll out of view. */
const AGENT_COLUMN_MIN_GRID_WIDTH = 1120;

type Group = 'all' | 'paid' | 'waiting' | 'blocked' | 'other';

const GROUPS: Array<{ id: Group; label: string; statuses: PurchaseStatus[] | null }> = [
  { id: 'all', label: 'All', statuses: null },
  { id: 'paid', label: 'Paid', statuses: ['paid'] },
  { id: 'waiting', label: 'Waiting', statuses: ['on_hold', 'settling', 'processing'] },
  { id: 'blocked', label: 'Blocked', statuses: ['blocked'] },
  { id: 'other', label: 'Denied & expired', statuses: ['denied', 'expired', 'failed'] },
];

export interface LedgerContext {
  approve: (id: string) => void;
  deny: (id: string) => void;
  now: number;
}

type CellProps = ICellRendererParams<Purchase, unknown, LedgerContext>;

function itemsText(purchase: Purchase | undefined): string {
  return purchase?.items?.map((item) => (item.quantity > 1 ? `${item.quantity} × ${item.name}` : item.name)).join(', ') ?? '';
}

function MerchantCell({ data, node }: CellProps) {
  if (!data) return null;
  if (node.rowPinned) return <strong>{data.merchant}</strong>;
  return (
    <div className="cell-merchant">
      <span>{data.merchant}</span>
      <small>{itemsText(data)}</small>
    </div>
  );
}

/** The status pill, with the PayPal object behind the row on a second line. */
function StatusCell({ data, node }: CellProps) {
  if (!data || node.rowPinned) return null;
  let paypal: string | null = null;
  let title: string | undefined;
  if (data.paypalOrderId) {
    const id = data.paypalCaptureId ?? data.paypalAuthorizationId ?? data.paypalOrderId;
    const what = data.paypalCaptureId ? 'Capture' : data.paypalAuthorizationId ? 'Auth' : 'Order';
    paypal = `${what} ${shortId(id)}`;
    title = `PayPal ${data.paypalMode === 'simulated' ? '(simulated) ' : ''}${data.paypalStatus ?? data.paypalOrderStatus ?? ''}\nOrder ${data.paypalOrderId}\n${what} ${id}`;
  } else if (data.status === 'blocked') {
    paypal = 'No PayPal order';
  } else if (data.error) {
    paypal = 'Not sent to PayPal';
  }
  return (
    <div className="cell-status" title={title}>
      <StatusPill status={data.status} />
      {paypal && <small className="mono">{paypal}</small>}
    </div>
  );
}

function WhyCell({ data, node }: CellProps) {
  if (!data) return null;
  if (node.rowPinned) return <span className="muted">{data.explanation}</span>;
  const flags = data.ai.status === 'ok' && data.decisionSource === 'ai' ? data.ai.review.redFlags : [];
  return (
    <div className="cell-why">
      <SourceTag source={data.decisionSource} decision={data.decision} /> {data.explanation}
      {flags.length > 0 && (
        <div className="flags">
          {flags.slice(0, 3).map((flag) => (
            <span className="flag" key={flag}>
              {flag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function ActionsCell({ data, node, context }: CellProps) {
  const [clicked, setClicked] = useState(false);
  useEffect(() => setClicked(false), [data?.status]);
  if (!data || node.rowPinned) return null;
  if (data.status === 'settling' || (clicked && data.status === 'on_hold')) {
    return (
      <div className="cell-actions">
        <Spinner /> Asking PayPal…
      </div>
    );
  }
  if (data.status !== 'on_hold') return null;
  return (
    <div className="cell-actions" title={data.holdExpiresAt ? `Auto-void in ${timeLeft(data.holdExpiresAt, context.now)}` : undefined}>
      <button
        type="button"
        className="btn approve small"
        onClick={() => {
          setClicked(true);
          context.approve(data.id);
        }}
      >
        Approve
      </button>
      <button
        type="button"
        className="btn deny small"
        onClick={() => {
          setClicked(true);
          context.deny(data.id);
        }}
      >
        Deny
      </button>
    </div>
  );
}

interface Props {
  rows: Purchase[];
  context: LedgerContext;
  onOpen: (id: string) => void;
}

export function Ledger({ rows, context, onOpen }: Props) {
  const gridRef = useRef<AgGridReact<Purchase>>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [group, setGroup] = useState<Group>('all');
  const [agent, setAgent] = useState('all');
  const [search, setSearch] = useState('');
  const [totals, setTotals] = useState<Partial<Purchase>[]>([]);
  const filters = useRef({ group, agent });
  filters.current = { group, agent };

  const agents = useMemo(() => [...new Set(rows.map((row) => row.agentName))].sort(), [rows]);
  const currency = rows[0]?.currency ?? 'USD';

  const columns = useMemo<ColDef<Purchase>[]>(
    () => [
      {
        headerName: 'Time',
        field: 'createdAt',
        width: 112,
        sort: 'desc',
        valueFormatter: (p) => (p.node?.rowPinned ? '' : p.value ? formatTime(p.value as string) : ''),
        // The CSV gets the full ISO timestamp, not just the time of day.
        useValueFormatterForExport: false,
        tooltipValueGetter: (p) => (p.value ? new Date(p.value as string).toLocaleString() : ''),
      },
      { headerName: 'Agent', field: 'agentName', width: 150, tooltipField: 'agentName' },
      {
        headerName: 'Purchase',
        field: 'merchant',
        minWidth: 170,
        flex: 1.2,
        cellRenderer: MerchantCell,
        tooltipValueGetter: (p) => (p.node?.rowPinned ? '' : `${p.data?.merchant ?? ''}: ${itemsText(p.data)}`),
        getQuickFilterText: (p) => `${p.data?.merchant ?? ''} ${itemsText(p.data)} ${p.data?.merchantUrl ?? ''}`,
      },
      {
        headerName: 'Amount',
        field: 'amountCents',
        width: 104,
        type: 'rightAligned',
        cellStyle: { fontVariantNumeric: 'tabular-nums', fontWeight: 600 },
        valueFormatter: (p) => (typeof p.value === 'number' ? formatMoney(p.value, p.data?.currency ?? currency) : ''),
      },
      {
        headerName: 'Status',
        field: 'status',
        width: 168,
        cellRenderer: StatusCell,
        enableCellChangeFlash: true,
      },
      {
        headerName: 'Why',
        field: 'explanation',
        minWidth: 240,
        flex: 2.4,
        wrapText: true,
        autoHeight: true,
        cellRenderer: WhyCell,
        getQuickFilterText: (p) => `${p.data?.explanation ?? ''} ${p.data?.reason ?? ''}`,
      },
      {
        headerName: '',
        colId: 'actions',
        width: 164,
        sortable: false,
        resizable: false,
        cellRenderer: ActionsCell,
      },
      // Never shown: the full values the cells above abbreviate, for the CSV export.
      { headerName: 'Items', colId: 'items', hide: true, valueGetter: (p) => itemsText(p.data) },
      {
        headerName: 'PayPal',
        colId: 'paypal',
        hide: true,
        valueGetter: (p) =>
          [p.data?.paypalStatus, p.data?.paypalCaptureId ?? p.data?.paypalAuthorizationId ?? p.data?.paypalOrderId].filter(Boolean).join(' '),
      },
    ],
    [currency],
  );

  const defaultColDef = useMemo<ColDef<Purchase>>(() => ({ sortable: true, resizable: true, suppressMovable: true }), []);

  const rowClassRules = useMemo<RowClassRules<Purchase>>(
    () => ({ 'row-hold': (p) => p.data?.status === 'on_hold' || p.data?.status === 'settling' }),
    [],
  );

  const isExternalFilterPresent = useCallback(() => filters.current.group !== 'all' || filters.current.agent !== 'all', []);
  const doesExternalFilterPass = useCallback((node: IRowNode<Purchase>) => {
    const data = node.data;
    if (!data) return false;
    const statuses = GROUPS.find((g) => g.id === filters.current.group)?.statuses;
    if (statuses && !statuses.includes(data.status)) return false;
    return filters.current.agent === 'all' || data.agentName === filters.current.agent;
  }, []);

  const fitColumns = useCallback((api: GridApi<Purchase>, width: number) => {
    if (width > 0) api.setColumnsVisible(['agentName'], width >= AGENT_COLUMN_MIN_GRID_WIDTH);
  }, []);

  const recomputeTotals = useCallback(() => {
    const api = gridRef.current?.api;
    if (!api) return;
    let count = 0;
    let paid = 0;
    let held = 0;
    api.forEachNodeAfterFilter((node) => {
      if (!node.data) return;
      count++;
      if (node.data.status === 'paid') paid += node.data.amountCents;
      if (node.data.status === 'on_hold' || node.data.status === 'settling') held += node.data.amountCents;
    });
    if (count === 0) {
      setTotals([]);
      return;
    }
    setTotals([
      {
        id: '__totals',
        merchant: `Paid · ${count} shown`,
        amountCents: paid,
        currency,
        explanation: held ? `+ ${formatMoney(held, currency)} on hold, not charged` : '',
        items: [],
      },
    ]);
  }, [currency]);

  useEffect(() => {
    gridRef.current?.api?.onFilterChanged();
  }, [group, agent]);

  const getRowId = useCallback((p: GetRowIdParams<Purchase>) => p.data.id, []);

  return (
    <div className="card">
      <div className="ledger-toolbar">
        <div className="segmented" role="tablist" aria-label="Filter by outcome">
          {GROUPS.map((g) => (
            <button key={g.id} type="button" role="tab" aria-selected={group === g.id} className={group === g.id ? 'active' : ''} onClick={() => setGroup(g.id)}>
              {g.label}
            </button>
          ))}
        </div>
        <select className="select" value={agent} onChange={(event) => setAgent(event.target.value)} aria-label="Filter by agent">
          <option value="all">All agents</option>
          {agents.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <input className="search" placeholder="Search merchant, item, reason…" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="Search the ledger" />
        <span className="spacer" />
        <button type="button" className="btn small" onClick={() => gridRef.current?.api?.exportDataAsCsv({ fileName: 'allowance-ledger.csv', columnKeys: ['createdAt', 'agentName', 'merchant', 'items', 'amountCents', 'status', 'explanation', 'paypal'] })}>
          Export CSV
        </button>
      </div>
      <div className="grid-wrap" ref={wrapRef}>
        <AgGridReact<Purchase>
          ref={gridRef}
          theme={gridTheme}
          rowData={rows}
          columnDefs={columns}
          defaultColDef={defaultColDef}
          getRowId={getRowId}
          context={context}
          domLayout="autoHeight"
          pagination
          paginationPageSize={20}
          paginationPageSizeSelector={[20, 50, 100]}
          quickFilterText={search}
          isExternalFilterPresent={isExternalFilterPresent}
          doesExternalFilterPass={doesExternalFilterPass}
          rowClassRules={rowClassRules}
          pinnedBottomRowData={totals as Purchase[]}
          suppressCellFocus
          tooltipShowDelay={400}
          overlayNoRowsTemplate='<span class="empty">No purchases yet. Run <code>npm run demo</code> or connect an agent from Agents &amp; setup.</span>'
          onRowClicked={(event) => {
            // The grid sees a click on the row's own buttons before React could stop it.
            if ((event.event?.target as Element | null)?.closest('button')) return;
            if (event.data && !event.node.rowPinned) onOpen(event.data.id);
          }}
          onFilterChanged={recomputeTotals}
          onRowDataUpdated={recomputeTotals}
          onGridSizeChanged={(event) => fitColumns(event.api, event.clientWidth)}
          onGridReady={(event) => {
            fitColumns(event.api, wrapRef.current?.clientWidth ?? 0);
            recomputeTotals();
          }}
        />
      </div>
    </div>
  );
}
