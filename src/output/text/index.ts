// Text mode renderers — Layer 3: Pure text output (no ANSI, no borders)
// Receives ViewModels as input, outputs via console.log

export {
  // Usage
  renderTextUsageSummary,
  renderTextUsageBreakdown,
} from './usage.js';

export {
  // Models
  renderTextModelsList,
  renderTextModelDetail,
} from './models.js';

export {
  // Doctor
  renderTextDoctor,
} from './doctor.js';
