export const TOKEN_PLAN_PURCHASE_EXAMPLES = {
  individual:
    'qianwen subscription tokenplan purchase <individual-token-plan-type> --channel alipay --billing-cycle <cycle> --no-auto-renew',
  team: 'qianwen subscription tokenplan purchase token_plan_team --channel alipay --billing-cycle <cycle> --standard-seat-count <n> --no-auto-renew',
} as const;
