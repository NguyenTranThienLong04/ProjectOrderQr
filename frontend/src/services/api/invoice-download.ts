const invoiceFilePattern = /^SmartOrder-INV-\d{8}-[A-HJ-NP-Z2-9]{8}\.pdf$/;

export function downloadInvoiceBlob(blob: Blob, disposition?: string): string | undefined {
  const candidate = disposition?.match(/filename="([^"]+)"/)?.[1];
  const filename = candidate && invoiceFilePattern.test(candidate) ? candidate : 'SmartOrder-invoice.pdf';
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return filename.match(/^SmartOrder-(INV-.+)\.pdf$/)?.[1];
}
