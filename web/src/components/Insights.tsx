import {
  AgStudioAiModule,
  studioTheme,
  type AgBaseWidgetDefinition,
  type AgDefaultRegistry,
  type AgDefaultWidgetDefinition,
  type AgFieldDefinition,
  type AgReportState,
  type AgStudioApi,
  type AgWidgetsConfig,
} from 'ag-studio';
import { AgStudio, AgStudioProvider, createWidgets } from 'ag-studio-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CATEGORY_LABELS, type Purchase, type PurchaseStatus } from '../types';
import { allowanceAi } from './insightsAi';

/** Rows go to Studio in this order, so each outcome takes the same palette colour everywhere: paid green, held amber, blocked red. */
const OUTCOME_ORDER: PurchaseStatus[] = ['paid', 'on_hold', 'settling', 'blocked', 'denied', 'expired', 'failed', 'processing'];
const STUDIO_MODULES = [AgStudioAiModule];
/** Every money field is a sum already: legends and labels read "Paid", not "Paid (sum)". */
const LOCALE = { aggregationSumFieldName: '${name}', aggregationSumBucketName: '${name}' };
import { AgentWatchlist, watchlistForm, type WatchlistWidget } from './AgentWatchlist';

/** Studio's widgets plus Allowance's own. */
interface AllowanceRegistry extends Omit<AgDefaultRegistry, 'widgets'> {
  widgets: readonly (AgDefaultWidgetDefinition | AgBaseWidgetDefinition<'agent-watchlist', WatchlistWidget>)[];
}

/** A number per agent: the money paid or the attempts blocked. */
const measure = (required: boolean) => ({
  type: 'field' as const,
  supportedRoles: ['numeric' as const],
  requires: { per: 'dataMapping.agent' as const, cardinality: 'one' as const },
  required,
});

const widgets = (config: AgWidgetsConfig) =>
  createWidgets<AllowanceRegistry>({
    additionalTypes: [
      {
        id: 'agent-watchlist',
        label: 'Agent watchlist',
        icon: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 3l7 2.6v5.2c0 4.2-2.9 7.5-7 8.9-4.1-1.4-7-4.7-7-8.9V5.6z"/><path d="M9 11h6M9 14h4"/></svg>',
        comp: AgentWatchlist,
        dataMapping: {
          agent: { type: 'field', supportedRoles: ['category'], requires: { cardinality: 'many' }, required: true },
          paid: measure(true),
          blocked: measure(true),
          aiBlocked: measure(false),
        },
        form: watchlistForm,
        defaultSize: { width: 360, height: 300 },
        minSize: { width: 240, height: 160 },
        ai: { description: 'Agents ranked by blocked attempts, with the money each one paid. Clicking an agent filters the dashboard to it.' },
      },
    ],
    menu: [{ label: 'Allowance', widgetIds: ['agent-watchlist'] }, ...config.menu],
  });

const OUTCOME: Record<PurchaseStatus, string> = {
  paid: 'Paid',
  on_hold: 'Held for the owner',
  settling: 'Held for the owner',
  processing: 'Processing',
  blocked: 'Blocked',
  denied: 'Denied by the owner',
  expired: 'Expired',
  failed: 'Failed',
};

const DECIDED_BY = { rules: 'Rules', ai: 'AI review', ai_unavailable: 'Rules (AI down)' } as const;

/** One flat row per purchase request: the shape AG Studio works with. */
function toRow(purchase: Purchase) {
  const amount = purchase.amountCents / 100;
  const held = purchase.status === 'on_hold' || purchase.status === 'settling';
  const blocked = purchase.status === 'blocked';
  return {
    time: purchase.createdAt,
    agent: purchase.agentName,
    merchant: purchase.merchant,
    category: CATEGORY_LABELS[purchase.items[0]?.category ?? 'other'],
    outcome: OUTCOME[purchase.status],
    decidedBy: DECIDED_BY[purchase.decisionSource],
    amount,
    paid: purchase.status === 'paid' ? amount : 0,
    held: held ? amount : 0,
    blockedAmount: blocked ? amount : 0,
    declined: purchase.status === 'denied' || purchase.status === 'expired' ? amount : 0,
    blocked: blocked ? 1 : 0,
    aiBlocked: blocked && purchase.decisionSource === 'ai' ? 1 : 0,
    why: purchase.explanation,
  };
}

/** Studio follows the dashboard's dark palette. */
const theme = studioTheme.withParams({
  browserColorScheme: 'dark',
  backgroundColor: '#141922',
  foregroundColor: '#e8ebf2',
  textColor: '#e8ebf2',
  subtleTextColor: '#8d96a8',
  accentColor: '#7b93ff',
  borderColor: '#262e3b',
  menuBackgroundColor: '#1a2030',
  menuTextColor: '#e8ebf2',
  tooltipBackgroundColor: '#1a2030',
  tooltipTextColor: '#e8ebf2',
  chartTextColor: '#e8ebf2',
  chartSubtleTextColor: '#8d96a8',
  chartAxisLineColor: '#354052',
  chartTooltipBackgroundColor: '#1a2030',
  chartTooltipTextColor: '#e8ebf2',
  studioCanvasBackgroundColor: '#0c0f15',
  studioWidgetBackgroundColor: '#141922',
  // Palette order = the stacked measures (paid, held, blocked, denied), then the brand for anything else.
  ...Object.fromEntries(
    ['#43d391', '#f3c15a', '#ff7d7d', '#8d96a8', '#7b93ff'].flatMap((color, index) => [
      [`chartPaletteFills${index + 1}Color`, color],
      [`chartPaletteStrokes${index + 1}Color`, color],
    ]),
  ),
});

/** A widget's reference to a field of the requests table: Studio names fields `table.field`. */
const field = (id: string, aggregation?: 'sum' | 'count') => ({ id: `requests.${id}`, ...(aggregation ? { aggregation } : {}) });

/** The dashboard every owner starts from; in Customize mode it can be changed freely. */
const INITIAL_STATE = {
  selectedPageId: 'overview',
  panels: { filters: { collapsed: true } },
  pages: [
    {
      id: 'overview',
      layout: {
        columns: 12,
        rowHeight: 52,
        backgroundColor: '#0c0f15',
        widgetBackgroundColor: '#141922',
        widgetBorderEnabled: true,
        widgetBorderColor: '#262e3b',
        widgetBorderWidth: 1,
        widgetBorderRadius: 12,
        widgetPadding: 14,
      },
      widgets: {
        kpis: {
          type: 'multi-kpi',
          format: {
            title: { text: 'Where the money went', enabled: true },
            style: {
              columns: 4,
              verticalAlign: 'center',
              typography: { fontSize: 28, fontWeight: 'bold' },
              columnSeparator: { enabled: true, width: 1, color: '#262e3b' },
            },
          },
          dataMapping: { values: [field('paid', 'sum'), field('held', 'sum'), field('blockedAmount', 'sum'), field('aiBlocked', 'sum')] },
        },
        byAgent: {
          type: 'bar-chart-stacked',
          format: {
            title: { text: 'Spend by agent', enabled: true },
            // On the right the four outcomes stack and all fit; at the bottom they would page.
            style: { theme: { common: { legend: { enabled: true, position: 'right' } } } },
          },
          // Four measures, not a split by outcome: each keeps its palette colour even when it is zero.
          dataMapping: {
            categoryKey: [field('agent')],
            valueKey: [field('paid', 'sum'), field('held', 'sum'), field('blockedAmount', 'sum'), field('declined', 'sum')],
          },
        },
        byDecider: {
          type: 'donut-chart',
          format: { title: { text: 'Who decided', enabled: true } },
          dataMapping: { categoryKey: [field('decidedBy')], valueKey: [field('amount', 'count')] },
        },
        watchlist: {
          type: 'agent-watchlist',
          format: { title: { text: 'Agent watchlist', enabled: true } },
          dataMapping: { agent: [field('agent')], paid: [field('paid', 'sum')], blocked: [field('blocked', 'sum')], aiBlocked: [field('aiBlocked', 'sum')] },
        },
        requests: {
          type: 'grid',
          format: { title: { text: 'Every request', enabled: true } },
          dataMapping: { cols: ['time', 'agent', 'merchant', 'amount', 'outcome', 'decidedBy', 'why'].map((id) => field(id)) },
          sort: [{ field: field('time'), direction: 'desc' }],
        },
      },
      widgetLayout: {
        kpis: { xTrack: 0, yTrack: 0, xSpan: 12, ySpan: 3 },
        watchlist: { xTrack: 0, yTrack: 3, xSpan: 4, ySpan: 5 },
        byAgent: { xTrack: 4, yTrack: 3, xSpan: 5, ySpan: 5 },
        byDecider: { xTrack: 9, yTrack: 3, xSpan: 3, ySpan: 5 },
        requests: { xTrack: 0, yTrack: 8, xSpan: 12, ySpan: 6 },
      },
    },
  ],
} as unknown as AgReportState;

export function Insights({ rows, currency }: { rows: Purchase[]; currency: string }) {
  // The license key comes from the local server at runtime, so it is never part of the built bundle.
  const [licenseKey, setLicenseKey] = useState<string | null | undefined>(undefined);
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  // Studio reads its AI setup once; the auditor's tool reads the live rows through this ref.
  const requests = useRef(rows);
  requests.current = rows;
  const ai = useMemo(() => allowanceAi(requests), []);
  const studio = useRef<AgStudioApi | null>(null);
  const customized = useRef(false);
  useEffect(() => {
    const api = studio.current;
    if (mode !== 'edit' || !api || customized.current) return;
    customized.current = true;
    // Studio builds the edit panels on the first Customize. Compose and data start folded, so the AI assistant sits
    // next to the page; both are one click away.
    const timer = setTimeout(() => {
      const state = api.getState();
      api.setState({ ...state, panels: { ...state.panels, edit: { collapsed: true }, data: { collapsed: true } } });
    }, 0);
    return () => clearTimeout(timer);
  }, [mode]);
  useEffect(() => {
    fetch('/api/insights/config')
      .then((response) => response.json() as Promise<{ licenseKey: string | null }>)
      .then((config) => setLicenseKey(config.licenseKey))
      .catch(() => setLicenseKey(null));
  }, []);

  const data = useMemo(() => {
    const money = { format: 'currencyFormat', formatOptions: { format: new Intl.NumberFormat('en-US', { style: 'currency', currency }) } } as const;
    const text = { format: 'textFormat' } as const;
    const count = { format: 'integerFormat' } as const;
    const fields = [
      { id: 'time', name: 'Time', format: 'dateTimeFormat' },
      { id: 'agent', name: 'Agent', ...text },
      { id: 'merchant', name: 'Merchant', ...text },
      { id: 'category', name: 'Category', ...text },
      { id: 'outcome', name: 'Outcome', ...text },
      { id: 'decidedBy', name: 'Decided by', ...text },
      { id: 'amount', name: 'Amount', ...money },
      { id: 'paid', name: 'Paid', ...money },
      { id: 'held', name: 'Held, not charged', ...money },
      { id: 'blockedAmount', name: 'Kept from leaving', ...money },
      { id: 'declined', name: 'Denied or expired', ...money },
      { id: 'blocked', name: 'Blocked attempts', ...count },
      { id: 'aiBlocked', name: 'Stopped by the AI review', ...count },
      { id: 'why', name: 'Why', ...text },
    ] as unknown as AgFieldDefinition[];
    const ordered = [...rows].sort((a, b) => OUTCOME_ORDER.indexOf(a.status) - OUTCOME_ORDER.indexOf(b.status));
    return { sources: [{ id: 'requests', name: 'Purchase requests', data: ordered.map(toRow), fields }] };
  }, [rows, currency]);

  if (licenseKey === undefined) return <div className="empty">Loading insights…</div>;
  return (
    <div className="insights-wrap">
      <div className="section-title">
        <h2>Insights</h2>
        <span>Built with AG Studio on the same requests as the ledger.</span>
        <span className="spacer" />
        <button type="button" className="btn small" onClick={() => setMode(mode === 'view' ? 'edit' : 'view')}>
          {mode === 'view' ? 'Customize' : 'Done'}
        </button>
      </div>
      <div className="card insights">
        <AgStudioProvider licenseKey={licenseKey ?? undefined} modules={STUDIO_MODULES}>
          <AgStudio<AllowanceRegistry>
            data={data}
            mode={mode}
            theme={theme}
            widgets={widgets}
            ai={ai}
            localeText={LOCALE}
            onApiReady={(event) => {
              studio.current = event.api as unknown as AgStudioApi;
            }}
            initialState={INITIAL_STATE as unknown as AgReportState<AllowanceRegistry>}
            style={{ height: '100%', width: '100%' }}
          />
        </AgStudioProvider>
      </div>
    </div>
  );
}
