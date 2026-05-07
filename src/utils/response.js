export function successResponse(data = {}, meta = {}) {
  return {
    success: true,
    data,
    meta,
  };
}

export function paginatedResponse(data, page, limit, total) {
  return {
    success: true,
    data,
    meta: {
      page,
      limit,
      total,
      hasMore: page * limit < total,
    },
  };
}
