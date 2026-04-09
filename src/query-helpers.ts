import {
  PaginationQueryBuilder,
  SearchQueryBuilder,
  IncludesQueryBuilder,
  SortQueryBuilder,
  QueryBuilderType,
} from "@freshbooks/api/dist/models/builders";

export interface QueryBuilderOptions {
  page?: number;
  perPage?: number;
  search?: Record<string, string | number | boolean>;
  dateRange?: { key: string; min?: string; max?: string };
  sortBy?: string;
  sortOrder?: "asc" | "desc";
  includes?: string[];
}

/**
 * Build an array of FreshBooks query builders from a simplified options object.
 * Pass the result to any SDK .list() method as the queryBuilders parameter.
 */
export function buildQueryBuilders(options: QueryBuilderOptions): QueryBuilderType[] {
  const builders: QueryBuilderType[] = [];

  // Pagination
  if (options.page || options.perPage) {
    const pagination = new PaginationQueryBuilder();
    if (options.page) pagination.page(options.page);
    if (options.perPage) pagination.perPage(options.perPage);
    builders.push(pagination);
  }

  // Search filters
  if (options.search && Object.keys(options.search).length > 0) {
    const search = new SearchQueryBuilder();
    for (const [key, value] of Object.entries(options.search)) {
      if (typeof value === "boolean") {
        search.boolean(key, value);
      } else {
        search.equals(key, value);
      }
    }
    builders.push(search);
  }

  // Date range filter
  if (options.dateRange) {
    const search = new SearchQueryBuilder();
    search.between(options.dateRange.key, {
      min: options.dateRange.min,
      max: options.dateRange.max,
    });
    builders.push(search);
  }

  // Sorting
  if (options.sortBy) {
    const sort = new SortQueryBuilder();
    if (options.sortOrder === "asc") {
      sort.asc(options.sortBy);
    } else {
      sort.desc(options.sortBy);
    }
    builders.push(sort);
  }

  // Includes
  if (options.includes && options.includes.length > 0) {
    const includes = new IncludesQueryBuilder();
    for (const key of options.includes) {
      includes.includes(key);
    }
    builders.push(includes);
  }

  return builders;
}
