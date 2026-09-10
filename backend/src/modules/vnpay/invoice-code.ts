import { ServiceUnavailableException } from '@nestjs/common';
import { randomInt } from 'crypto';
import type { Model } from 'mongoose';
import type { PaymentIntentDocument } from './payment-intent.schema';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const INVOICE_CODE_PATTERN = /^INV-\d{8}-[A-HJ-NP-Z2-9]{8}$/;
export const INVOICE_CODE_ATTEMPTS = 5;

export function generateInvoiceCode(date = new Date()): string {
  const vietnamDate = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  const day = vietnamDate.toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = Array.from(
    { length: 8 },
    () => ALPHABET[randomInt(ALPHABET.length)],
  ).join('');
  return `INV-${day}-${suffix}`;
}

export function isInvoiceCodeCollision(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const duplicate = error as {
    code?: number;
    keyPattern?: Record<string, unknown>;
    keyValue?: Record<string, unknown>;
  };
  return (
    duplicate.code === 11000 &&
    (duplicate.keyPattern?.invoiceCode !== undefined ||
      duplicate.keyValue?.invoiceCode !== undefined)
  );
}

/** Retry only the invoice index: coverageKey/txnRef keep their existing handling. */
export async function withInvoiceCodeRetry<T>(
  write: (code: string) => Promise<T>,
  date = new Date(),
): Promise<T> {
  for (let attempt = 0; attempt < INVOICE_CODE_ATTEMPTS; attempt++) {
    try {
      return await write(generateInvoiceCode(date));
    } catch (error) {
      if (!isInvoiceCodeCollision(error)) throw error;
    }
  }
  throw new ServiceUnavailableException(
    'Chưa thể cấp mã hóa đơn. Vui lòng thử lại.',
  );
}

export async function ensureInvoiceCode(
  model: Model<PaymentIntentDocument>,
  intent: PaymentIntentDocument,
): Promise<string> {
  if (intent.invoiceCode) return intent.invoiceCode;
  return withInvoiceCodeRetry(async (invoiceCode) => {
    // Narrow migration exception to Mongoose immutability: driver CAS can only
    // fill missing/null legacy codes. Concurrent readers always reuse the winner.
    // No timestamps, status, amount or coverage are written by this operation.
    const updated = await model.collection.findOneAndUpdate(
      { _id: intent._id, invoiceCode: null },
      { $set: { invoiceCode } },
      { returnDocument: 'after' },
    );
    const persisted =
      updated ?? (await model.collection.findOne({ _id: intent._id }));
    const persistedCode: unknown = persisted?.invoiceCode;
    if (
      typeof persistedCode !== 'string' ||
      !INVOICE_CODE_PATTERN.test(persistedCode)
    ) {
      throw new ServiceUnavailableException(
        'Chưa thể đọc mã hóa đơn. Vui lòng thử lại.',
      );
    }
    return persistedCode;
  }, intent.createdAt ?? new Date());
}

export function invoiceFilename(invoiceCode: string): string {
  if (!INVOICE_CODE_PATTERN.test(invoiceCode)) {
    throw new ServiceUnavailableException('Mã hóa đơn lưu trữ không hợp lệ');
  }
  return `SmartOrder-${invoiceCode}.pdf`;
}
