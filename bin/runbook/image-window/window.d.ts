export declare const MAX_IMAGES: number;
export declare const IMAGE_LABEL: string;
export declare const DEFAULT_MAX_IMAGE_MIB: number;
export declare const MAX_IMAGE_BYTES: number;
export declare function imagesToDrop(
  sizes: number[],
  maxImages?: number,
  maxBytes?: number,
): number;
export declare function windowImages(
  payload: unknown,
  maxImages?: number,
  maxBytes?: number,
): unknown;
export declare function windowFetch(fetchFn: typeof fetch): typeof fetch;
