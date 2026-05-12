// View Models — Layer 2: Transform API data into render-friendly structures
// This layer is pure data — no React, no console.log, no side effects.

export {
  // Models
  buildModelListViewModel,
  buildModelListViewModelFromModels,
  buildModelDetailViewModel,
} from './models.js';
export type {
  ModelRowViewModel,
  ModelsListViewModel,
  ModelDetailViewModel,
  PricingLineViewModel,
  BuiltInToolViewModel,
  ContextViewModel,
  FreeTierSummaryViewModel,
} from './models.js';

export {
  // Usage Summary
  buildUsageSummaryViewModel,
  // Usage Breakdown
  buildUsageBreakdownViewModel,
} from './usage.js';
export type {
  UsageSummaryViewModel,
  FreeTierSectionViewModel,
  FreeTierRowViewModel,
  TokenPlanSectionViewModel,
  PayAsYouGoSectionViewModel,
  PayAsYouGoRowViewModel,
  UsageBreakdownViewModel,
  BreakdownColumn,
  BreakdownRowViewModel,
  BreakdownTotalViewModel,
} from './usage.js';

export {
  // Doctor
  buildDoctorViewModel,
} from './doctor.js';
export type { DoctorViewModel, DoctorCheckViewModel, DoctorCheck } from './doctor.js';
