// Public entry point for API → internal model mapping. Re-exports the four
// named functions consumed by the services and view-models layers; slice
// files in this directory carry the actual implementation.

export { mapApiModelToModel, mapApiModelToModelDetail, flattenApiModels } from './model.js';
export { mapFqInstanceToQuota } from './freetier.js';
