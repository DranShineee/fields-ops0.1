/** Pagination sederhana untuk daftar besar (NFR-PERF-002). */
export function paginate(queryParams, { defaultPer = 10, maxPer = 50 } = {}) {
  const page = Math.max(1, Number(queryParams.page) || 1);
  const per = Math.min(maxPer, Math.max(1, Number(queryParams.per) || defaultPer));
  return { page, per, offset: (page - 1) * per };
}

export function pageCount(total, per) {
  return Math.max(1, Math.ceil(total / per));
}

export function pageLink(baseUrl, params, page) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, value);
  }
  search.set('page', String(page));
  return `${baseUrl}?${search.toString()}`;
}
