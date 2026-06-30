export interface GetFundAccountAvailableAmountResponse {
  AvailableAmount?: string;
  Currency?: string;
  FundAccountStatus?: string;
  CreditAmount?: string;
  CashAmount?: string;
  UnclearedAmount?: string;
  UnpaidAmount?: string;
  CreditUser?: boolean;
  HistoryMonthUnclearedAmount?: string;
  CurrentMonthUnclearedAmount?: string;
  SettleCurrency?: string;
  FundAccountId?: string;
}

export interface BalanceSummaryDto {
  availableAmount: string;
  currency: string;
}
