export declare const MAX_IMAGES: number;
export declare const IMAGE_LABEL: string;
export declare const DEFAULT_SOFT_IMAGE_MIB: number;
export declare const DEFAULT_HARD_IMAGE_MIB: number;
export declare const SOFT_IMAGE_BYTES: number;
export declare const HARD_IMAGE_BYTES: number;
export declare function imagesToDrop(
  sizes: number[],
  maxImages?: number,
  softBytes?: number,
  hardBytes?: number,
): number;
export declare function windowImages(
  payload: unknown,
  maxImages?: number,
  softBytes?: number,
  hardBytes?: number,
): unknown;
export declare function windowFetch(fetchFn: typeof fetch): typeof fetch;
