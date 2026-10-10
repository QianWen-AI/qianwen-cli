import {
  parseTokenPlanCommodity,
  tokenPlanProtocolError,
  tokenPlanRecord,
} from '../api/parsers/tokenplan-trade.js';
import { site } from '../site.js';
import { MAX_TOKEN_PLAN_TEAM_SEATS, type TokenPlanSelection } from '../types/tokenplan-purchase.js';
import { isTokenPlanIndividualTier } from '../types/tokenplan-tiers.js';
import { DecimalAmount } from '../utils/decimal-amount.js';

type Property = { code: string; value: string; name?: string };
type Component = { componentCode: string; componentName?: string; instanceProperty: Property[] };

export function tokenPlanCommodityCode(edition: TokenPlanSelection['edition']): string {
  return edition === 'individual'
    ? site.features.tokenPlanCommodityCodes.soloBuy
    : site.features.tokenPlanCommodityCodes.teams;
}

export function buildTokenPlanConfigurations(
  data: unknown,
  selection: TokenPlanSelection,
  couponNum: string,
): ReadonlyArray<Record<string, unknown>> {
  const commodityCode = tokenPlanCommodityCode(selection.edition);
  const raw = parseTokenPlanCommodity(data, commodityCode);
  const meta = tokenPlanRecord(raw.componentsMeta)!;
  const values = tokenPlanRecord(raw.components)!;
  const view = tokenPlanRecord(raw.viewModel)!;
  const cycles = {
    monthly: ['1', 'Month', '个月'],
    quarterly: ['3', 'Month', '个月'],
    yearly: ['1', 'Year', '年'],
  } as const;
  const cycle = cycles[selection.billingCycle];
  if (!cycle || (selection.edition === 'team' && selection.billingCycle === 'quarterly'))
    return tokenPlanProtocolError();
  const [duration, pricingCycle, pricingCycleTitle] = cycle;
  const declared = (code: string): boolean => tokenPlanRecord(meta[code]) !== null;
  const options = (component: string, property = component): unknown[] => {
    const choices = tokenPlanRecord(values[component])?.[property];
    return Array.isArray(choices) ? choices : [];
  };
  const option = (component: string, value: string, property = component): Property => {
    if (!value.trim()) return tokenPlanProtocolError();
    const matches = options(component, property)
      .map(tokenPlanRecord)
      .filter((entry) => entry?.value === value);
    if (matches.length !== 1) return tokenPlanProtocolError();
    const name = matches[0]?.text;
    return { code: property, value, ...(typeof name === 'string' && name.trim() ? { name } : {}) };
  };
  if (!declared('ord_time') || selection.seats.length === 0) return tokenPlanProtocolError();
  option('ord_time', `${duration}:${pricingCycle}`);
  const total = selection.seats.reduce((count, seat) => count + seat.quantity, 0);
  const configuredMaximum = tokenPlanRecord(raw.config)?.per_user_max_num;
  if (configuredMaximum !== undefined) {
    const limit = tokenPlanRecord(configuredMaximum)?.value;
    if (typeof limit !== 'string' || !/^[1-9]\d{0,8}$/.test(limit) || total > Number(limit))
      return tokenPlanProtocolError();
  }
  if (
    !Number.isSafeInteger(total) ||
    total < 1 ||
    total > MAX_TOKEN_PLAN_TEAM_SEATS ||
    new Set(selection.seats.map((seat) => seat.specCode)).size !== selection.seats.length ||
    (selection.edition === 'individual' && (selection.seats.length !== 1 || total !== 1))
  )
    return tokenPlanProtocolError();
  return selection.seats.map(({ specCode, quantity }) => {
    const supportedTier =
      selection.edition === 'individual'
        ? isTokenPlanIndividualTier(specCode)
        : ['standard', 'pro', 'max'].some((tier) => tier === specCode);
    if (!supportedTier || !Number.isSafeInteger(quantity) || quantity < 1)
      return tokenPlanProtocolError();
    const components: Component[] = [];
    const add = (code: string, properties: Property[]) => {
      if (!declared(code)) return tokenPlanProtocolError();
      const name = tokenPlanRecord(meta[code])?.name;
      components.push({
        componentCode: code,
        ...(typeof name === 'string' ? { componentName: name } : {}),
        instanceProperty: properties,
      });
    };
    if (selection.edition === 'individual') {
      add('subscription_type', [option('subscription_type', specCode)]);
    } else {
      const plan = option('plan_type', specCode);
      const constraints = tokenPlanRecord(raw.constraint);
      const creditValues = tokenPlanRecord(tokenPlanRecord(constraints?.credit_value)?.plan_type)?.[
        specCode
      ];
      if (!Array.isArray(creditValues) || typeof creditValues[0] !== 'string')
        return tokenPlanProtocolError();
      DecimalAmount.parse(creditValues[0]);
      const credit = option('credit_value', creditValues[0]);
      if (!credit.name) return tokenPlanProtocolError();
      const ranges = tokenPlanRecord(tokenPlanRecord(constraints?.seat_num)?.plan_type)?.[specCode];
      if (ranges !== undefined) {
        if (!Array.isArray(ranges) || ranges.length !== 1) return tokenPlanProtocolError();
        const range = tokenPlanRecord(ranges[0]);
        const minimum = range?.min;
        const maximum = range?.max;
        const step = range?.step;
        if (
          typeof minimum !== 'number' ||
          !Number.isSafeInteger(minimum) ||
          minimum < 0 ||
          typeof maximum !== 'number' ||
          !Number.isSafeInteger(maximum) ||
          maximum < minimum ||
          typeof step !== 'number' ||
          !Number.isSafeInteger(step) ||
          step < 1 ||
          quantity < minimum ||
          quantity > maximum ||
          (quantity - minimum) % step !== 0
        )
          return tokenPlanProtocolError();
      }
      if (declared('subscription_spec')) {
        if (options('subscription_spec', 'quota_cycle').length > 0)
          option('subscription_spec', 'byDynamicMonth', 'quota_cycle');
        add('subscription_spec', [
          plan,
          { code: 'quota_cycle', value: 'byDynamicMonth' },
          credit,
          { code: 'seat_num', value: String(quantity) },
        ]);
      } else {
        add('plan_type', [plan]);
        add('credit_value', [credit]);
      }
      if (declared('offering_type')) {
        const first = tokenPlanRecord(options('offering_type')[0])?.value;
        if (typeof first !== 'string') return tokenPlanProtocolError();
        add('offering_type', [option('offering_type', first)]);
      }
      if (declared('showtime')) add('showtime', [option('showtime', 'now')]);
    }
    add('ord_time', [{ code: 'ord_time', value: `${duration}:${pricingCycle}` }]);
    if (declared('region')) {
      const first = tokenPlanRecord(options('region')[0])?.value;
      if (typeof first !== 'string') return tokenPlanProtocolError();
      add('region', [option('region', first)]);
    }
    for (const [code, value] of Object.entries(meta)) {
      const required = tokenPlanRecord(value)?.required;
      if (required !== undefined && typeof required !== 'boolean') return tokenPlanProtocolError();
      if (required === true && !components.some((component) => component.componentCode === code))
        return tokenPlanProtocolError();
    }
    const promotion = {
      promotionFilter: { youhui_quan: true },
      promotionOptionCode: 'youhui_quan',
      ...(couponNum !== 'default' ? { promotionOptionNo: couponNum } : {}),
    };
    const configuration = {
      commodityCode,
      specCode: commodityCode,
      ...(typeof view.name === 'string' ? { commodityName: view.name } : {}),
      chargeType: 'PREPAY',
      chargeTypeTitle: '预付费',
      orderType: 'BUY',
      autoRenew: selection.autoRenew,
      quantity,
      duration,
      pricingCycle,
      pricingCycleTitle,
      components,
      orderParams: {
        fromPage: 'qianwen-cli',
        order_created_by: 'qwen_cloud',
        deviceType: 'PC',
        pricing_trigger_type: 'default',
        init_price_query: 'init',
        has_triggered_error: false,
        needUnavailableCoupon: '1',
        RateWithTax: 'true',
        queryGetCouponActivity: false,
        promotion_input_param: JSON.stringify(promotion),
        ...(selection.autoRenew
          ? {
              is_auto_renew: 'true',
              auto_renew_duration: duration,
              auto_renew_cycUnit: pricingCycle,
            }
          : {}),
      },
      config: {
        order_time: { min: 1, max: 1, step: 1, unit: pricingCycle },
        supportAutoRenew: true,
        canChannelAutoRenew: true,
        orderType: 'BUY',
        showTilePrice: false,
        order_num: null,
        regionCode: null,
      },
      isMainDataMode: '',
      couponForSpecItem: true,
      couponNum,
    };
    return configuration;
  });
}
