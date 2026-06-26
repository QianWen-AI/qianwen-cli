export { truncateTitle, formatTicketTime, formatStatus } from './shared.js';
export {
  buildSupportListViewModel,
  type SupportListViewModel,
  type SupportListItemViewModel,
} from './list.js';
export {
  buildSupportViewViewModel,
  type SupportViewViewModel,
  type SupportMessageViewModel,
  type SupportTicketViewModel,
} from './view.js';
export {
  buildCategoryTreeViewModel,
  buildCategorySuggestionsViewModel,
  buildCreateTicketResultViewModel,
  type CategoryNodeViewModel,
  type CategoryTreeViewModel,
  type CategorySuggestionViewModel,
  type CategorySuggestionsViewModel,
  type CreateTicketResultViewModel,
} from './create.js';
export {
  buildSupportRateViewModel,
  buildRatingVisual,
  getRatingLabel,
  type SupportRateViewModel,
} from './rate.js';
