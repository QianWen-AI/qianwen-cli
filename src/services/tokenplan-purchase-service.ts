import type { ApiClient } from '../api/api-client.js';
import { parseSoloSubscription } from '../api/parsers/solo-subscription.js';
import { tokenPlanRecord } from '../api/parsers/tokenplan-trade.js';
import {
  API_ACTION_QUERY_AVAILABLE_INSTANCES,
  API_PRODUCT_BSS,
  API_PRODUCT_BSS_PAYMENT,
  API_TOKENPLAN_SOLO_SUBSCRIPTION,
} from '../types/api-routes.js';
import type {
  TokenPlanPurchasePreview,
  TokenPlanPurchaseResult,
  TokenPlanPaymentDisplayDetails,
  TokenPlanQuote,
  TokenPlanSelection,
} from '../types/tokenplan-purchase.js';
import type { CashFundingPlan, CashPaymentCapabilities } from '../types/tokenplan-payment.js';
import type { ExitCode } from '../utils/exit-codes.js';
import { classifyHttpError } from '../utils/api-errors.js';
import { CliError } from '../utils/errors.js';
import { DecimalAmount } from '../utils/decimal-amount.js';
import { computeFundingPlan, resolveDeductionIntent } from './tokenplan-payment-capabilities.js';
import { TokenPlanPurchaseGates } from './tokenplan-purchase-gates.js';
import { TOKEN_PLAN_PRICING_URL, TOKEN_PLAN_UNPAID_ORDER_URL } from './tokenplan-urls.js';
import { TokenPlanTradeService } from './tokenplan-trade-service.js';
import {
  buildTokenPlanCatalogConfiguration,
  TokenPlanCatalogPricing,
} from './tokenplan-catalog-pricing.js';
import { PAYMENT_POLL_TIMEOUT_MS, TokenPlanPaymentService } from './tokenplan-payment-service.js';
import { buildTokenPlanConfigurations, tokenPlanCommodityCode } from './tokenplan-configuration.js';
import { tokenPlanSleep, withTokenPlanDeadline } from './tokenplan-deadline.js';
import { resolveIndividualAutoRenewFlag } from './tokenplan-service.js';
import { safeSubscriptionError } from './subscription-diagnostics.js';

export type TokenPlanPurchaseDecision =
  | { action: 'confirm' | 'cancel' }
  | { action: 'coupon'; coupon: string }
  | { action: 'balance'; amount: string; intent?: CashFundingPlan['deductionIntent'] };

export interface TokenPlanPurchaseInteraction {
  onQuoteStart?(): void;
  review(
    preview: TokenPlanPurchasePreview,
    signal?: AbortSignal,
  ): Promise<TokenPlanPurchaseDecision>;
  payment(
    url: string | null,
    wait: Promise<unknown>,
    options?: {
      signal?: AbortSignal;
      expiresAt?: number;
      details?: TokenPlanPaymentDisplayDetails;
    },
  ): Promise<void | { skipPolling: true }>;
}

export interface TokenPlanPurchaseOutcome {
  result: TokenPlanPurchaseResult;
  exitCode: ExitCode;
  error?: CliError;
}

function preview(
  selection: TokenPlanSelection,
  quote: TokenPlanQuote,
  capabilities: CashPaymentCapabilities,
  intent: 'auto' | 'manual' | 'none',
  manualAmount: string | undefined,
  changed: boolean,
): TokenPlanPurchasePreview {
  const couponCoversAll = DecimalAmount.parse(quote.amount).compare(DecimalAmount.parse('0')) === 0;
  if (couponCoversAll && intent === 'manual') {
    // A zero quote disables actual cash use, but explicit authorization must still fit the balance.
    computeFundingPlan(
      capabilities,
      'manual',
      capabilities.cashMethod?.available ?? '0',
      manualAmount,
    );
  }
  const effectiveIntent = couponCoversAll && intent === 'manual' ? 'none' : intent;
  const effectiveManual = effectiveIntent === 'manual' ? manualAmount : undefined;
  const fundingPlan = computeFundingPlan(
    capabilities,
    effectiveIntent,
    quote.amount,
    effectiveManual,
  );
  if (fundingPlan.externalPayable !== '0' && !capabilities.alipayScanning) {
    throw new CliError({
      code: 'TOKENPLAN_ALIPAY_SCANNING_UNAVAILABLE',
      message: `Your account does not support Alipay QR payment. Use full cash balance deduction or continue on the unpaid orders page: ${TOKEN_PLAN_UNPAID_ORDER_URL}`,
      exitCode: 1,
    });
  }
  const orderPayable = DecimalAmount.parse(quote.amount);
  const cashAvailable = DecimalAmount.parse(capabilities.cashMethod?.available ?? '0');
  const maxDeduction = orderPayable.min(cashAvailable);
  return {
    selection,
    quote,
    balance: cashAvailable.toCanonicalString(),
    maxDeduction: maxDeduction.toCanonicalString(),
    balanceDeduction: fundingPlan.cashDeduction,
    externalPayable: fundingPlan.externalPayable,
    deductionValid: true,
    changed,
    capabilities,
    fundingPlan,
    deductionIntent: effectiveIntent,
  };
}

function fingerprint(value: TokenPlanPurchasePreview): string {
  return JSON.stringify([
    DecimalAmount.parse(value.quote.amount).toCanonicalString(),
    DecimalAmount.parse(value.quote.tradeAmount).toCanonicalString(),
    DecimalAmount.parse(value.quote.originalAmount).toCanonicalString(),
    DecimalAmount.parse(value.quote.planAmount).toCanonicalString(),
    DecimalAmount.parse(value.quote.promotionDeduction).toCanonicalString(),
    DecimalAmount.parse(value.quote.couponDeduction).toCanonicalString(),
    value.quote.currency,
    value.quote.coupon,
    value.balance,
    value.maxDeduction,
    value.balanceDeduction,
    value.deductionIntent,
    value.fundingPlan,
    value.capabilities.admissionResult,
    value.capabilities.cashMethod?.currency ?? null,
    value.capabilities.alipayScanning,
    value.capabilities.identityContext.site,
    value.capabilities.identityContext.nbid,
  ]);
}

function deductionChoice(decision: Extract<TokenPlanPurchaseDecision, { action: 'balance' }>): {
  intent: CashFundingPlan['deductionIntent'];
  manualAmount: string | undefined;
} {
  const amount = DecimalAmount.parse(decision.amount);
  const intent =
    decision.intent ?? (amount.compare(DecimalAmount.parse('0')) === 0 ? 'none' : 'manual');
  return { intent, manualAmount: intent === 'manual' ? amount.toCanonicalString() : undefined };
}

export class TokenPlanPurchaseService {
  private readonly trade: TokenPlanTradeService;
  private readonly gates: TokenPlanPurchaseGates;
  private readonly payment: TokenPlanPaymentService;
  private readonly catalogPricing: TokenPlanCatalogPricing;

  constructor(private readonly apiClient: ApiClient) {
    this.trade = new TokenPlanTradeService(apiClient);
    this.gates = new TokenPlanPurchaseGates(apiClient);
    this.payment = new TokenPlanPaymentService(apiClient);
    this.catalogPricing = new TokenPlanCatalogPricing(apiClient);
  }

  async preview(
    selection: TokenPlanSelection,
    couponId: string | undefined,
    parentSignal?: AbortSignal,
    onQuoteStart?: () => void,
  ): Promise<TokenPlanPurchasePreview> {
    const controller = new AbortController();
    const cancel = () => controller.abort(parentSignal?.reason);
    parentSignal?.addEventListener('abort', cancel, { once: true });
    if (parentSignal?.aborted) cancel();
    const signal = controller.signal;
    try {
      const metadata = await withTokenPlanDeadline(
        (current) => this.trade.getCommodity(selection.edition, current),
        signal,
      );
      const coupon = couponId ?? 'default';
      const intent = resolveDeductionIntent(selection.balanceDeduction);
      const manualAmount = intent === 'manual' ? selection.balanceDeduction! : undefined;
      const configurations = buildTokenPlanConfigurations(metadata, selection, coupon);
      await this.check(selection, configurations, signal);
      const catalogOriginalAmount = await this.getCatalogOriginalAmount(
        selection,
        metadata,
        signal,
      );
      return await this.quote(
        selection,
        configurations,
        coupon,
        intent,
        manualAmount,
        false,
        catalogOriginalAmount,
        signal,
        onQuoteStart,
      );
    } catch (error) {
      if (error instanceof CliError) {
        throw new CliError({
          code: error.code,
          message: error.message,
          exitCode: error.exitCode,
          ...(error.hint ? { hint: error.hint } : {}),
        });
      }
      throw safeSubscriptionError(
        error,
        'Token Plan preview could not be loaded. Try again later.',
      );
    } finally {
      parentSignal?.removeEventListener('abort', cancel);
      controller.abort();
    }
  }

  async purchase(
    selection: TokenPlanSelection,
    interaction: TokenPlanPurchaseInteraction,
    parentSignal?: AbortSignal,
    previewAmount?: string,
    initialCoupon?: string,
  ): Promise<TokenPlanPurchaseOutcome> {
    const controller = new AbortController();
    const cancel = () => controller.abort(parentSignal?.reason);
    parentSignal?.addEventListener('abort', cancel, { once: true });
    if (parentSignal?.aborted) cancel();
    const signal = controller.signal;
    const result: TokenPlanPurchaseResult = {
      stage: 'preflight',
      status: 'failed',
      type: selection.type,
      billingCycle: selection.billingCycle,
      amount: null,
      currency: null,
      requestedAutoRenew: selection.autoRenew,
      autoRenewStatus: 'unknown',
      paymentOrderId: null,
      orderIds: null,
      activationStatus: 'not_checked',
      paymentAttempted: false,
      paymentMode: undefined,
      cashDeduction: undefined,
      externalPayable: undefined,
      settledAmount: undefined,
    };
    let created = false;
    let createStartedAt = 0;
    let paymentWriteKnown = false;
    let paymentTerminalKnown = false;
    try {
      const metadata = await withTokenPlanDeadline(
        (current) => this.trade.getCommodity(selection.edition, current),
        signal,
      );
      let coupon = initialCoupon ?? 'default';
      let intent = resolveDeductionIntent(selection.balanceDeduction);
      let manualAmount = intent === 'manual' ? selection.balanceDeduction! : undefined;
      let configurations = buildTokenPlanConfigurations(metadata, selection, coupon);
      await this.check(selection, configurations, signal);
      const catalogOriginalAmount = await this.getCatalogOriginalAmount(
        selection,
        metadata,
        signal,
      );
      let current = await this.quote(
        selection,
        configurations,
        coupon,
        intent,
        manualAmount,
        false,
        catalogOriginalAmount,
        signal,
        interaction.onQuoteStart,
      );
      for (let attempt = 0; ; attempt += 1) {
        if (attempt >= 20)
          throw new CliError({
            code: 'TOKENPLAN_QUOTE_UNSTABLE',
            message: 'The quote kept changing. No order was created; try again later.',
            exitCode: 1,
          });
        result.amount = current.quote.amount;
        result.currency = current.quote.currency;
        signal?.throwIfAborted();
        const decision = await interaction.review(current, signal);
        signal?.throwIfAborted();
        if (decision.action === 'cancel')
          return { result: { ...result, status: 'cancelled' }, exitCode: 0 };
        if (decision.action === 'coupon') {
          if (
            decision.coupon !== 'youhuiquan_promotion_option_id_for_blank' &&
            !current.quote.coupons.some((candidate) => candidate.id === decision.coupon)
          ) {
            throw new CliError({
              code: 'TOKENPLAN_COUPON_INVALID',
              message: 'The selected coupon is not available in this quote.',
              exitCode: 1,
            });
          }
          coupon = decision.coupon;
          configurations = buildTokenPlanConfigurations(metadata, selection, coupon);
          current = await this.quote(
            selection,
            configurations,
            coupon,
            intent,
            manualAmount,
            true,
            catalogOriginalAmount,
            signal,
            interaction.onQuoteStart,
          );
          continue;
        }
        if (decision.action === 'balance') {
          ({ intent, manualAmount } = deductionChoice(decision));
          current = preview(
            selection,
            current.quote,
            current.capabilities,
            intent,
            manualAmount,
            true,
          );
          continue;
        }
        if (!current.deductionValid || !current.fundingPlan)
          throw new CliError({
            code: 'TOKENPLAN_BALANCE_EXCEEDED',
            message: 'Choose a balance deduction within the displayed limit before confirming.',
            exitCode: 1,
          });
        coupon = current.quote.coupon;
        configurations = buildTokenPlanConfigurations(metadata, selection, coupon);
        const refreshed = await this.quote(
          selection,
          configurations,
          coupon,
          intent,
          manualAmount,
          false,
          catalogOriginalAmount,
          signal,
          interaction.onQuoteStart,
        );
        result.amount = refreshed.quote.amount;
        result.currency = refreshed.quote.currency;
        if (fingerprint(refreshed) !== fingerprint(current)) {
          current = { ...refreshed, changed: true };
          continue;
        }
        current = refreshed;
        await this.check(selection, configurations, signal);

        // --preview-amount anchor check: quote finalized, before order creation
        if (previewAmount !== undefined) {
          const expected = DecimalAmount.parse(previewAmount);
          const actual = DecimalAmount.parse(current.quote.amount);
          if (expected.compare(actual) !== 0) {
            throw new CliError({
              code: 'TOKENPLAN_QUOTE_CHANGED',
              message: `Quote changed: expected ¥${previewAmount}, actual ¥${current.quote.amount}. Re-run with --preview to get the current price.`,
              exitCode: 1,
            });
          }
        }

        break;
      }
      signal?.throwIfAborted();
      const order = await withTokenPlanDeadline(async (currentSignal) => {
        currentSignal.throwIfAborted();
        result.stage = 'create';
        createStartedAt = Date.now();
        return this.payment.createOrders(configurations, currentSignal);
      }, signal);
      result.paymentOrderId = order.paymentOrderId;
      result.orderIds = order.orderIds;
      created = true;
      signal?.throwIfAborted();
      const confirmedFundingPlan = current.fundingPlan!;
      const initialFingerprint = fingerprint(current);
      let confirmedFingerprint = initialFingerprint;
      let finalPlan: CashFundingPlan | null = null;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const [settlement, refreshedCaps] = await Promise.all([
          withTokenPlanDeadline(
            (currentSignal) =>
              this.payment.getOrderSettlement(order.paymentOrderId, currentSignal, order.orderIds),
            signal,
          ),
          withTokenPlanDeadline(
            (currentSignal) => this.gates.getPaymentCapabilities(selection.edition, currentSignal),
            signal,
          ),
        ]);
        signal.throwIfAborted();
        result.settledAmount = settlement.settledPayable;
        const prepared = preview(
          selection,
          { ...current.quote, amount: settlement.settledPayable },
          refreshedCaps,
          intent,
          manualAmount,
          true,
        );
        const preparedFingerprint = fingerprint(prepared);
        if (preparedFingerprint !== initialFingerprint) result.settlementDrifted = true;
        if (prepared.fundingPlan && preparedFingerprint === confirmedFingerprint) {
          finalPlan = prepared.fundingPlan;
          break;
        }
        const decision = await interaction.review(
          {
            ...prepared,
            existingOrder: { ...order, confirmedFundingPlan },
          },
          signal,
        );
        signal.throwIfAborted();
        if (decision.action === 'cancel')
          return { result: { ...result, status: 'cancelled' }, exitCode: 0 };
        if (decision.action === 'coupon')
          throw new CliError({
            code: 'TOKENPLAN_ORDER_ALREADY_CREATED',
            message:
              'The existing order cannot change coupons. No payment was attempted; use read-only recovery.',
            exitCode: 1,
          });
        if (decision.action === 'balance') {
          ({ intent, manualAmount } = deductionChoice(decision));
          confirmedFingerprint = '';
          continue;
        }
        if (!prepared.fundingPlan)
          throw new CliError({
            code: 'TOKENPLAN_BALANCE_EXCEEDED',
            message: 'Choose an available deduction amount before confirming the existing order.',
            exitCode: 1,
          });
        confirmedFingerprint = preparedFingerprint;
      }
      if (!finalPlan)
        throw new CliError({
          code: 'TOKENPLAN_SETTLEMENT_UNSTABLE',
          message:
            'Payment amounts kept changing. The order is saved and no payment was attempted; use read-only recovery.',
          exitCode: 1,
        });
      result.paymentMode = finalPlan.paymentMode;
      result.cashDeduction = finalPlan.cashDeduction;
      result.externalPayable = finalPlan.externalPayable;
      signal?.throwIfAborted();
      const merged = await withTokenPlanDeadline(async (currentSignal) => {
        currentSignal.throwIfAborted();
        result.stage = 'payment';
        return this.payment.mergePay({
          paymentOrderId: order.paymentOrderId,
          amount: finalPlan.orderPayable,
          balanceDeduction: finalPlan.cashDeduction,
          signal: currentSignal,
          onRequestStart: () => {
            result.paymentAttempted = true;
          },
        });
      }, signal);
      paymentWriteKnown = merged.status !== 'unknown';
      if (merged.status === 'succeeded' || merged.status === 'failed') {
        paymentTerminalKnown = true;
        result.status = merged.status;
        if (merged.status === 'succeeded') result.activationStatus = 'pending';
      } else if (merged.status === 'pending') {
        result.status = 'pending';
      }
      if (!paymentTerminalKnown) signal.throwIfAborted();
      if (merged.status === 'failed')
        return {
          result: { ...result, status: 'failed' },
          exitCode: 1,
          error: new CliError({
            code: 'TOKENPLAN_PAYMENT_FAILED',
            message:
              'Payment was rejected. Check the order before trying again:\n  qianwen subscription orders --type purchase',
            exitCode: 1,
          }),
        };
      if (merged.status === 'unknown')
        return {
          result: { ...result, status: 'unknown' },
          exitCode: 8,
          error: new CliError({
            code: 'TOKENPLAN_PAYMENT_UNKNOWN',
            message:
              'Payment outcome is unknown. Do not pay again. Check the order first:\n  qianwen subscription orders --type purchase',
            exitCode: 8,
          }),
        };
      if (merged.status !== 'succeeded') {
        const deadlineAt = Date.now() + PAYMENT_POLL_TIMEOUT_MS;
        const waiting = this.payment
          .waitForPaymentResult(order.paymentOrderId, { signal, deadlineAt })
          .then((paid) => {
            if (
              paid.status === 'succeeded' ||
              paid.status === 'failed' ||
              paid.status === 'cancelled'
            ) {
              paymentTerminalKnown = true;
              result.status = paid.status;
              if (paid.reason !== undefined) result.reason = paid.reason;
              if (paid.status === 'succeeded') result.activationStatus = 'pending';
            }
            return paid;
          });
        void waiting.catch(() => {});
        result.paymentUrl = merged.url ?? undefined;
        const paymentResult = await interaction.payment(merged.url, waiting, {
          signal,
          expiresAt: deadlineAt,
          details: {
            paymentOrderId: order.paymentOrderId,
            type: selection.type,
            billingCycle: selection.billingCycle,
            payableAmount: finalPlan.externalPayable,
            ...(selection.edition === 'team'
              ? {
                  totalSeats: selection.seats.reduce((total, seat) => total + seat.quantity, 0),
                }
              : {}),
          },
        });
        if (paymentResult?.skipPolling) {
          signal.throwIfAborted();
          if (!paymentTerminalKnown) {
            result.status = 'pending';
            return { result, exitCode: 8 };
          }
        }
        const paid = await waiting;
        if (!paymentTerminalKnown) signal.throwIfAborted();
        if (paid.status !== 'succeeded') {
          result.status =
            paid.status === 'failed' || paid.status === 'cancelled'
              ? paid.status
              : paid.status === 'timed_out'
                ? 'timed_out'
                : 'unknown';
          const exitCode = paid.status === 'failed' || paid.status === 'cancelled' ? 1 : 8;
          return {
            result,
            exitCode,
            ...(paid.status === 'cancelled'
              ? {}
              : {
                  error: new CliError({
                    code:
                      paid.status === 'failed'
                        ? 'TOKENPLAN_PAYMENT_FAILED'
                        : 'TOKENPLAN_PAYMENT_INCOMPLETE',
                    message:
                      paid.status === 'failed'
                        ? 'Payment was rejected. Check the order before trying again:\n  qianwen subscription orders --type purchase'
                        : `Payment is not confirmed. Do not create or pay again.\nCheck order status:\n  qianwen subscription orders --type purchase\nCancel or manage orders at:\n  ${TOKEN_PLAN_UNPAID_ORDER_URL}`,
                    exitCode,
                  }),
                }),
          };
        }
      }
      result.status = 'succeeded';
      result.activationStatus = 'pending';
      await this.refreshActivation(selection, result, createStartedAt, signal);
      return { result, exitCode: 0 };
    } catch (caught) {
      const error =
        caught instanceof CliError && caught.code === 'TOKENPLAN_CREDIT_NOT_SUPPORTED'
          ? new CliError({
              code: caught.code,
              message: created
                ? `Your account uses credit-based payment, which the CLI does not support. Manage the existing order at:\n  ${TOKEN_PLAN_UNPAID_ORDER_URL}`
                : `Your account uses credit-based payment, which the CLI does not support. Purchase at:\n  ${TOKEN_PLAN_PRICING_URL}`,
              exitCode: caught.exitCode,
            })
          : caught;
      if (paymentTerminalKnown) {
        if (result.status === 'succeeded') {
          result.activationStatus = 'pending';
          result.warning =
            'Payment succeeded, but a follow-up display or activation check did not complete. Verify Token Plan status separately.';
          return { result, exitCode: 0 };
        }
        if (result.status === 'cancelled') return { result, exitCode: 1 };
        return {
          result: { ...result, status: 'failed' },
          exitCode: 1,
          error: new CliError({
            code: 'TOKENPLAN_PAYMENT_FAILED',
            message:
              'Payment was rejected. Check the order before trying again:\n  qianwen subscription orders --type purchase',
            exitCode: 1,
          }),
        };
      }
      const interrupted = signal?.aborted === true;
      const rejectedCreate =
        error instanceof CliError &&
        (error.code === 'TOKENPLAN_ORDER_REJECTED' ||
          error.code === 'TOKENPLAN_REAL_NAME_REQUIRED');
      const unknownWrite =
        (result.stage === 'create' && !created && !rejectedCreate) ||
        (result.paymentAttempted === true && !paymentWriteKnown);
      result.status = unknownWrite
        ? 'unknown'
        : paymentWriteKnown
          ? 'pending'
          : interrupted
            ? 'cancelled'
            : 'failed';
      const knownPending = paymentWriteKnown && result.status === 'pending';
      const classification = classifyHttpError(error);
      const exitCode: ExitCode = interrupted
        ? 130
        : unknownWrite
          ? 8
          : knownPending
            ? 8
            : created
              ? 1
              : error instanceof CliError
                ? error.exitCode
                : classification.exitCode;
      return {
        result,
        exitCode,
        error: new CliError({
          code: interrupted
            ? 'INTERRUPTED'
            : unknownWrite
              ? 'TOKENPLAN_WRITE_UNKNOWN'
              : knownPending
                ? 'TOKENPLAN_PAYMENT_INCOMPLETE'
                : error instanceof CliError
                  ? error.code
                  : 'TOKENPLAN_PURCHASE_FAILED',
          message: interrupted
            ? 'Token Plan purchase interrupted. Retain any order identifier for read-only recovery.'
            : unknownWrite
              ? 'The write outcome is unknown. Do not retry purchase or payment; use read-only recovery.'
              : paymentWriteKnown
                ? 'Payment is pending, but status polling did not finish. Use read-only recovery; do not pay again.'
                : created
                  ? `${error instanceof CliError ? error.message : 'Payment preparation failed.'} An order exists; use read-only recovery. Do not create another order.`
                  : error instanceof CliError
                    ? error.message
                    : 'Token Plan purchase checks failed; no order was created.',
          exitCode,
        }),
      };
    } finally {
      parentSignal?.removeEventListener('abort', cancel);
      controller.abort();
    }
  }

  private check(
    selection: TokenPlanSelection,
    configurations: ReadonlyArray<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<void> {
    return withTokenPlanDeadline(async (current) => {
      await Promise.all([
        this.gates.checkAccount(selection.edition, current),
        this.trade.checkInventory(configurations, current),
      ]);
    }, signal);
  }

  private async quote(
    selection: TokenPlanSelection,
    configurations: ReadonlyArray<Record<string, unknown>>,
    coupon: string,
    intent: 'auto' | 'manual' | 'none',
    manualAmount: string | undefined,
    changed: boolean,
    catalogOriginalAmount: string | null,
    signal?: AbortSignal,
    onQuoteStart?: () => void,
  ): Promise<TokenPlanPurchasePreview> {
    return withTokenPlanDeadline(async (current) => {
      onQuoteStart?.();
      const [quote, capabilities] = await Promise.all([
        this.trade.getQuote(configurations, coupon, current),
        this.gates.getPaymentCapabilities(selection.edition, current),
      ]);
      const displayOriginal =
        catalogOriginalAmount !== null &&
        DecimalAmount.parse(catalogOriginalAmount).compare(DecimalAmount.parse(quote.planAmount)) >=
          0
          ? catalogOriginalAmount
          : null;
      const resolvedQuote =
        displayOriginal === null
          ? quote
          : {
              ...quote,
              originalAmount: displayOriginal,
              promotionDeduction: DecimalAmount.parse(displayOriginal)
                .subtract(DecimalAmount.parse(quote.planAmount))
                .toCanonicalString(),
            };
      return preview(selection, resolvedQuote, capabilities, intent, manualAmount, changed);
    }, signal);
  }

  private async getCatalogOriginalAmount(
    selection: TokenPlanSelection,
    commodity: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (selection.edition !== 'individual') return null;
    try {
      const specCode = selection.seats[0]?.specCode;
      if (!specCode) return null;
      const configuration = buildTokenPlanCatalogConfiguration(
        selection.edition,
        specCode,
        selection.billingCycle,
        commodity,
      );
      const catalogPrice = await this.catalogPricing.getPrice(configuration, {
        edition: selection.edition,
        specCode,
        authenticated: true,
        signal,
      });
      return catalogPrice.originalPrice;
    } catch {
      signal?.throwIfAborted();
      // Catalog list-price data is display-only. Purchase safety and settlement use the
      // authenticated trade quote when the catalog pricing request is unavailable.
      return null;
    }
  }

  private async refreshActivation(
    selection: TokenPlanSelection,
    result: TokenPlanPurchaseResult,
    startedAt: number,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await withTokenPlanDeadline(
        async (current) => {
          const refreshStarted = Date.now();
          for (let attempt = 0; attempt < 5; attempt += 1) {
            if (attempt > 0)
              await tokenPlanSleep(
                Math.max(0, refreshStarted + attempt * 3_000 - Date.now()),
                current,
              );
            current.throwIfAborted();
            if (selection.edition === 'individual') {
              const [response, availableInstances] = await Promise.all([
                this.apiClient.callCsDataApi({
                  api: API_TOKENPLAN_SOLO_SUBSCRIPTION,
                  data: { commodityCode: tokenPlanCommodityCode(selection.edition) },
                  signal: current,
                  parse: parseSoloSubscription,
                }),
                this.apiClient
                  .callFlatApi({
                    product: API_PRODUCT_BSS_PAYMENT,
                    action: API_ACTION_QUERY_AVAILABLE_INSTANCES,
                    params: {},
                    signal: current,
                  })
                  .catch(() => null),
              ]);
              current.throwIfAborted();
              const entity = response.subscription;
              if (
                response.status === 'active' &&
                entity?.specCode === selection.seats[0].specCode &&
                entity.startTime >= startedAt
              ) {
                result.activationStatus = 'visible';
                result.autoRenewStatus = resolveIndividualAutoRenewFlag(entity, availableInstances)
                  ? 'enabled'
                  : 'disabled';
                return;
              }
            } else {
              const raw = tokenPlanRecord(
                await this.apiClient.callFlatApi({
                  product: API_PRODUCT_BSS,
                  action: 'GetSeatSubscriptionSummary',
                  params: { productCode: tokenPlanCommodityCode('team') },
                  signal: current,
                }),
              );
              current.throwIfAborted();
              const data = tokenPlanRecord(raw?.Data);
              if (!raw || raw.Code !== 'Success' || raw.Success !== true || !data) return;
              if (
                [raw, data].some((value) =>
                  ['ProductCode', 'productCode', 'CommodityCode', 'commodityCode'].some(
                    (field) =>
                      Object.hasOwn(value, field) &&
                      value[field] !== tokenPlanCommodityCode('team'),
                  ),
                )
              )
                return;
              const start = typeof data.StartTime === 'string' ? Date.parse(data.StartTime) : NaN;
              const end = typeof data.EndTime === 'string' ? Date.parse(data.EndTime) : NaN;
              const groups = Array.isArray(data.SubscriptionGroupList)
                ? data.SubscriptionGroupList.map(tokenPlanRecord)
                : [];
              if (
                Number.isFinite(start) &&
                start >= startedAt &&
                start <= Date.now() &&
                end > Date.now() &&
                selection.seats.every((seat) => {
                  const matches = groups.filter((group) => group?.SpecType === seat.specCode);
                  return (
                    matches.length === 1 && matches[0]?.SubscriptionTotalNumber === seat.quantity
                  );
                }) &&
                groups.length === selection.seats.length
              ) {
                result.activationStatus = 'visible';
                return;
              }
            }
          }
        },
        signal,
        15_000,
      );
    } catch {
      // Payment already succeeded; activation remains pending on refresh failure or cancellation.
    }
  }
}
