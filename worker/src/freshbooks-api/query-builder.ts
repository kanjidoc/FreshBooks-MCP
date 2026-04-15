/**
 * Builds URL query parameters for FreshBooks API list endpoints.
 * Replaces the SDK's PaginationQueryBuilder, SearchQueryBuilder,
 * SortQueryBuilder, and IncludesQueryBuilder.
 */

export interface QueryBuilderOptions {
  page?: number;
  perPage?: number;
  search?: Record<string, string | number | boolean>;
  /** "like" search — keys should already include _like suffix */
  searchLike?: Record<string, string>;
  /** "in" search — for multi-value filters like clientids */
  searchIn?: Record<string, (string | number)[]>;
  dateRange?: { key: string; min?: string; max?: string };
  sortBy?: string;
  sortOrder?: "asc" | "desc";
  includes?: string[];
  /**
   * Endpoint type affects sort syntax.
   * Accounting: sort=field_asc / sort=field_desc
   * Project: sort=field / sort=-field
   */
  endpointType?: "accounting" | "project";
}

/**
 * Build a query string from options. Returns the string without leading "?".
 * Returns empty string if no params are specified.
 */
export function buildQueryParams(options: QueryBuilderOptions): string {
  const params = new URLSearchParams();

  // Pagination
  if (options.page !== undefined) {
    params.set("page", String(options.page));
  }
  if (options.perPage !== undefined) {
    params.set("per_page", String(options.perPage));
  }

  // Search filters (equals / boolean)
  if (options.search) {
    for (const [key, value] of Object.entries(options.search)) {
      if (value === undefined || value === null) continue;
      if (typeof value === "boolean") {
        // Boolean filters are top-level, not under search[]
        params.set(key, String(value));
      } else {
        params.set(`search[${key}]`, String(value));
      }
    }
  }

  // Like search
  if (options.searchLike) {
    for (const [key, value] of Object.entries(options.searchLike)) {
      if (value === undefined) continue;
      params.set(`search[${key}]`, value);
    }
  }

  // In search (multi-value)
  if (options.searchIn) {
    for (const [key, values] of Object.entries(options.searchIn)) {
      for (const val of values) {
        params.append(`search[${key}][]`, String(val));
      }
    }
  }

  // Date range
  if (options.dateRange) {
    const { key, min, max } = options.dateRange;
    if (min) params.set(`search[${key}_min]`, min);
    if (max) params.set(`search[${key}_max]`, max);
  }

  // Sorting
  if (options.sortBy) {
    const type = options.endpointType ?? "accounting";
    if (type === "project") {
      // Project endpoints: sort=field (asc) or sort=-field (desc)
      const prefix = options.sortOrder === "desc" ? "-" : "";
      params.set("sort", `${prefix}${options.sortBy}`);
    } else {
      // Accounting endpoints: sort=field_asc or sort=field_desc
      const direction = options.sortOrder ?? "desc";
      params.set("sort", `${options.sortBy}_${direction}`);
    }
  }

  // Includes
  if (options.includes) {
    for (const inc of options.includes) {
      params.append("include[]", inc);
    }
  }

  return params.toString();
}
