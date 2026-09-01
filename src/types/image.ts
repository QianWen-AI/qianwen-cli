/** Types for the image modality: generation input and normalized artifacts. */

export interface ImageArtifact {
  url: string;
  path?: string;
  b64?: string;
}

export interface ImageResult {
  artifacts: ImageArtifact[];
  [key: string]: unknown;
}
