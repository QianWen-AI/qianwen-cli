import type {
  SubscriptionGrayDto,
  SeatSubscriptionSummaryDto,
  SubscriptionDetailDto,
  SubscriptionDetailInstance,
  AutoRenewalDto,
  InstancesRenewableDto,
  OrderListDto,
  SubscriptionOrder,
  OrderDetail,
  OrderDetailLine,
} from '../../types/subscription.js';

function toAmountString(value: unknown, fallback = '0'): string {
  if (value == null) return fallback;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : fallback;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length === 0 ? fallback : trimmed;
  }
  return fallback;
}

function toQuantity(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

interface RawSubscriptionGray {
  IsGray?: unknown;
}

export function transformSubscriptionGray(raw: unknown): SubscriptionGrayDto {
  const safe: RawSubscriptionGray = (raw ?? {}) as RawSubscriptionGray;
  return { isGray: typeof safe.IsGray === 'boolean' ? safe.IsGray : null };
}

interface RawSeatSubscriptionSummary {
  PeriodStart?: string | number;
  PeriodEnd?: string | number;
  StartTime?: string | number;
  EndTime?: string | number;
  PlanName?: string;
  PlanCode?: string;
  Seats?: number;
  Data?: RawSeatSubscriptionSummary;
}

function toPeriodIso(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.length > 0 ? value : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return null;
}

export function transformSeatSubscriptionSummary(raw: unknown): SeatSubscriptionSummaryDto {
  const outer: RawSeatSubscriptionSummary = (raw ?? {}) as RawSeatSubscriptionSummary;
  const inner = (outer.Data ?? {}) as RawSeatSubscriptionSummary;
  const pick = <K extends keyof RawSeatSubscriptionSummary>(
    key: K,
  ): RawSeatSubscriptionSummary[K] | undefined => inner[key] ?? outer[key];

  const start = toPeriodIso(pick('PeriodStart') ?? pick('StartTime'));
  const end = toPeriodIso(pick('PeriodEnd') ?? pick('EndTime'));
  const period = start && end ? { start, end } : null;

  const planName = pick('PlanName');
  const planCode = pick('PlanCode');
  const seats = pick('Seats');

  return {
    plan: typeof planName === 'string' && planName.length > 0 ? planName : null,
    planCode: typeof planCode === 'string' && planCode.length > 0 ? planCode : null,
    period,
    seats: typeof seats === 'number' ? seats : null,
  };
}

interface RawSubscriptionDetailItem {
  InstanceId?: string;
  Status?: string;
  PlanName?: string;
  StartTime?: string;
  EndTime?: string;
}

interface RawSubscriptionDetail {
  Data?: RawSubscriptionDetailItem[];
}

export function transformSubscriptionDetail(raw: unknown): SubscriptionDetailDto {
  const safe: RawSubscriptionDetail = (raw ?? {}) as RawSubscriptionDetail;
  const list = Array.isArray(safe.Data) ? safe.Data : [];
  const instances: SubscriptionDetailInstance[] = list.map((i) => {
    const period =
      typeof i.StartTime === 'string' &&
      i.StartTime.length > 0 &&
      typeof i.EndTime === 'string' &&
      i.EndTime.length > 0
        ? { start: i.StartTime, end: i.EndTime }
        : null;
    return {
      instanceId: i.InstanceId ?? '',
      status: i.Status ?? '',
      plan: typeof i.PlanName === 'string' && i.PlanName.length > 0 ? i.PlanName : null,
      period,
    };
  });
  const activeInstance = instances.find((i) => i.status === 'VALID') ?? null;
  return { instances, activeInstance };
}

interface RawAutoRenewal {
  Data?: { AutoRenewal?: boolean | number };
  EnableRenew?: boolean;
  AutoRenewal?: boolean;
  Enable?: boolean;
}

export function transformAutoRenewal(raw: unknown): AutoRenewalDto {
  const safe: RawAutoRenewal = (raw ?? {}) as RawAutoRenewal;
  if (safe.Data != null) {
    const ar = safe.Data.AutoRenewal;
    if (typeof ar === 'boolean') return { autoRenew: ar };
    if (typeof ar === 'number') return { autoRenew: ar !== 0 };
  }
  if (typeof safe.EnableRenew === 'boolean') return { autoRenew: safe.EnableRenew };
  if (typeof safe.AutoRenewal === 'boolean') return { autoRenew: safe.AutoRenewal };
  if (typeof safe.Enable === 'boolean') return { autoRenew: safe.Enable };
  return { autoRenew: null };
}

interface RawRenewableItem {
  CanRenew?: boolean;
  canRenew?: boolean;
}

interface RawInstancesRenewable {
  Data?: RawRenewableItem[];
  Renewable?: boolean;
}

export function transformInstancesRenewable(raw: unknown): InstancesRenewableDto {
  const safe: RawInstancesRenewable = (raw ?? {}) as RawInstancesRenewable;
  if (Array.isArray(safe.Data) && safe.Data.length > 0) {
    const first = safe.Data[0];
    if (first) {
      const canRenew = first.CanRenew ?? first.canRenew;
      if (typeof canRenew === 'boolean') return { renewable: canRenew };
    }
  }
  return { renewable: typeof safe.Renewable === 'boolean' ? safe.Renewable : null };
}

interface RawOrder {
  OrderId?: string;
  OrderType?: string;
  GmtCreate?: string;
  GmtPay?: string;
  OrderTime?: string;
  PayAmount?: unknown;
  TradeAmount?: unknown;
  CashAmount?: unknown;
  OriginalAmount?: unknown;
  PostTaxAmount?: unknown;
  PretaxAmount?: unknown;
  Amount?: unknown;
  Currency?: string;
  SettCurrency?: string;
  OrderStatus?: string;
  Status?: string;
}

interface RawOrderList {
  Data?: RawOrder[];
  TotalCount?: number;
  PageSize?: number;
  CurrentPage?: number;
}

export function transformOrderList(raw: unknown): OrderListDto {
  const safe: RawOrderList = (raw ?? {}) as RawOrderList;
  const list = Array.isArray(safe.Data) ? safe.Data : [];
  const orders: SubscriptionOrder[] = list.map((o) => {
    const order: SubscriptionOrder = {
      orderId: o.OrderId ?? '',
      orderType: o.OrderType ?? '',
      orderTime: o.GmtCreate ?? o.GmtPay ?? o.OrderTime ?? '',
      amount: toAmountString(
        o.PayAmount ??
          o.TradeAmount ??
          o.CashAmount ??
          o.OriginalAmount ??
          o.PostTaxAmount ??
          o.PretaxAmount ??
          o.Amount,
        '0',
      ),
      status: o.OrderStatus ?? o.Status ?? '',
    };
    const currency = o.Currency ?? o.SettCurrency;
    if (typeof currency === 'string' && currency.length > 0) {
      order.currency = currency;
    }
    return order;
  });
  return {
    orders,
    pagination: {
      totalCount: typeof safe.TotalCount === 'number' ? safe.TotalCount : orders.length,
      pageSize: typeof safe.PageSize === 'number' ? safe.PageSize : 20,
      currentPage: typeof safe.CurrentPage === 'number' ? safe.CurrentPage : 1,
    },
  };
}

interface RawOrderItem {
  Name?: string;
  Quantity?: unknown;
  Amount?: unknown;
}

interface RawOrderDetail {
  OrderId?: string;
  OrderType?: string;
  OrderTime?: string;
  Amount?: unknown;
  Status?: string;
  Items?: RawOrderItem[];
  InvoiceUrl?: string;
}

export function transformOrderDetail(raw: unknown): OrderDetail {
  const safe: RawOrderDetail = (raw ?? {}) as RawOrderDetail;
  const items: OrderDetailLine[] = Array.isArray(safe.Items)
    ? safe.Items.map((it) => ({
        name: it.Name ?? '',
        quantity: toQuantity(it.Quantity),
        amount: toAmountString(it.Amount, '0'),
      }))
    : [];
  return {
    orderId: safe.OrderId ?? '',
    orderType: safe.OrderType ?? '',
    orderTime: safe.OrderTime ?? '',
    amount: toAmountString(safe.Amount, '0'),
    status: safe.Status ?? '',
    items,
    invoiceUrl:
      typeof safe.InvoiceUrl === 'string' && safe.InvoiceUrl.length > 0 ? safe.InvoiceUrl : null,
  };
}
