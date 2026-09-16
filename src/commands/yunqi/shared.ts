import { invalidArgError } from '../../utils/errors.js';

/**
 * `subscribe` and `unsubscribe` both take an optional positional that the docs
 * and all three shell completion scripts advertise as `forum`. Forum is the
 * only subscribable resource so the value carries no routing information, but
 * accepting anything silently would let `yunqi subscribe forums` go unnoticed.
 */
export function validateForumResource(raw: string | undefined): void {
  if (raw !== undefined && raw !== 'forum') {
    throw invalidArgError(`Unknown resource '${raw}'. Use 'forum'.`);
  }
}
