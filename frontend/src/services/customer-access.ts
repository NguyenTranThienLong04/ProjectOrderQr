export interface CustomerGrant {
  customerToken: string;
  sessionId: string;
  tableId: string;
  expiresAt: number;
}

export class SessionScopeError extends Error {
  constructor() { super('Phiên tại bàn đã thay đổi. Vui lòng quét lại QR tại bàn.'); }
}

export function isSessionUnavailable(error: unknown) {
  const status = (error as { response?: { status?: number } })?.response?.status;
  return error instanceof SessionScopeError || [401, 403, 404, 410].includes(status ?? 0);
}

export function saveCustomerGrant(grant: CustomerGrant) {
  localStorage.setItem(`customer-socket:${grant.sessionId}:${grant.tableId}`, grant.customerToken);
  localStorage.setItem(`customer-table:${grant.tableId}`, grant.customerToken);
  localStorage.setItem(`customer-scope:${grant.sessionId}`, grant.tableId);
}

export function customerToken(sessionId: string, tableId: string) {
  return localStorage.getItem(`customer-socket:${sessionId}:${tableId}`) ?? '';
}

// A payment return can name the primary table of a merged session. Keep using
// the physical-table scope actually granted to this browser for that session.
export function customerScopeTable(sessionId: string, fallback: string) {
  return localStorage.getItem(`customer-scope:${sessionId}`) ?? fallback;
}

export function customerEntryHeaders(tableId: string) {
  const params = new URLSearchParams(window.location.search);
  if (params.get('tableId') === tableId && params.get('tableToken')) {
    localStorage.setItem(`table-entry:${tableId}`, params.get('tableToken')!);
  }
  const tableToken = localStorage.getItem(`table-entry:${tableId}`);
  return {
    'x-table-token': tableToken ?? '',
    'x-customer-token': localStorage.getItem(`customer-table:${tableId}`) ?? '',
  };
}
