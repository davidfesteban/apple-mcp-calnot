export class PaginatedResult {
  constructor({ items, page, pageSize, hasMore, syncing = false, partial = false, message = null }) {
    this.items = items;
    this.pagination = {
      page,
      pageSize,
      hasMore,
      nextPage: hasMore ? page + 1 : null
    };
    this.syncing = syncing;
    this.partial = partial;
    this.message = message;
  }

  map(mapper) {
    return new PaginatedResult({
      items: this.items.map(mapper),
      page: this.pagination.page,
      pageSize: this.pagination.pageSize,
      hasMore: this.pagination.hasMore,
      syncing: this.syncing,
      partial: this.partial,
      message: this.message
    });
  }

  withSyncStatus({ syncing, message }) {
    return new PaginatedResult({
      items: this.items,
      page: this.pagination.page,
      pageSize: this.pagination.pageSize,
      hasMore: this.pagination.hasMore,
      syncing,
      partial: syncing,
      message
    });
  }
}
