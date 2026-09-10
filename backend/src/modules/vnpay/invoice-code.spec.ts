import { model, Types } from 'mongoose';
import { PaymentIntentSchema } from './payment-intent.schema';
import {
  ensureInvoiceCode,
  generateInvoiceCode,
  INVOICE_CODE_ATTEMPTS,
  INVOICE_CODE_PATTERN,
  invoiceFilename,
  withInvoiceCodeRetry,
} from './invoice-code';

describe('Public invoice codes', () => {
  const collision = { code: 11000, keyPattern: { invoiceCode: 1 } };
  it('uses the Vietnam calendar date and unambiguous uppercase secure alphabet', () => {
    const codes = Array.from({ length: 100 }, () =>
      generateInvoiceCode(new Date('2026-09-09T17:00:00Z')),
    );
    for (const code of codes) {
      expect(code).toMatch(INVOICE_CODE_PATTERN);
      expect(code).toMatch(/^INV-20260910-/);
    }
    expect(new Set(codes).size).toBe(100);
  });
  it('generates only on new document validation, never on legacy hydration', async () => {
    const Intent = model('InvoiceCodeUnit', PaymentIntentSchema);
    expect(
      Intent.hydrate({ _id: new Types.ObjectId() }).invoiceCode,
    ).toBeUndefined();
    const doc = new Intent({
      txnRef: 'test',
      coverageKey: 'test',
      sessionId: new Types.ObjectId(),
      tableId: new Types.ObjectId(),
      amount: 100,
      paymentUrl: 'test',
      expiresAt: new Date(),
    });
    await doc.validate();
    expect(doc.invoiceCode).toMatch(INVOICE_CODE_PATTERN);
    const saved = Intent.hydrate(doc.toObject());
    saved.invoiceCode = 'INV-20260910-AAAAAAAA';
    expect(saved.invoiceCode).toBe(doc.invoiceCode);
  });
  it('declares an immutable field and unique partial index compatible with missing legacy codes', () => {
    expect(PaymentIntentSchema.path('invoiceCode').options.immutable).toBe(
      true,
    );
    expect(PaymentIntentSchema.indexes()).toContainEqual([
      { invoiceCode: 1 },
      {
        unique: true,
        partialFilterExpression: { invoiceCode: { $type: 'string' } },
      },
    ]);
  });
  it('regenerates on invoice collision and returns the successful write', async () => {
    const write = jest
      .fn<Promise<string>, [string]>()
      .mockRejectedValueOnce(collision)
      .mockResolvedValue('saved');
    await expect(withInvoiceCodeRetry(write)).resolves.toBe('saved');
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[0][0]).not.toBe(write.mock.calls[1][0]);
  });
  it('bounds repeated collision with a controlled 503', async () => {
    const write = jest.fn().mockRejectedValue(collision);
    await expect(withInvoiceCodeRetry(write)).rejects.toMatchObject({
      status: 503,
    });
    expect(write).toHaveBeenCalledTimes(INVOICE_CODE_ATTEMPTS);
  });
  it.each([
    { code: 11000, keyPattern: { coverageKey: 1 } },
    { code: 11000, keyPattern: { txnRef: 1 } },
    new Error('network'),
  ])('does not retry another index or unrelated failure %j', async (error) => {
    const write = jest.fn().mockRejectedValue(error);
    await expect(withInvoiceCodeRetry(write)).rejects.toBe(error);
    expect(write).toHaveBeenCalledTimes(1);
  });
  it('reuses a legacy CAS winner and preserves timestamps/payment fields', async () => {
    const code = 'INV-20260910-K7P4X2M9';
    const collection = {
      findOneAndUpdate: jest
        .fn<
          Promise<null>,
          [
            { _id: Types.ObjectId; invoiceCode: null },
            { $set: { invoiceCode: string } },
            object,
          ]
        >()
        .mockResolvedValue(null),
      findOne: jest.fn().mockResolvedValue({ invoiceCode: code }),
    };
    const intent = { _id: new Types.ObjectId(), createdAt: new Date() };
    await expect(
      ensureInvoiceCode({ collection } as never, intent as never),
    ).resolves.toBe(code);
    expect(collection.findOneAndUpdate.mock.calls[0][0]).toEqual({
      _id: intent._id,
      invoiceCode: null,
    });
    expect(
      Object.keys(collection.findOneAndUpdate.mock.calls[0][1].$set),
    ).toEqual(['invoiceCode']);
    await expect(
      ensureInvoiceCode(
        { collection } as never,
        { ...intent, invoiceCode: code } as never,
      ),
    ).resolves.toBe(code);
    expect(collection.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });
  it('bounds legacy collisions too', async () => {
    const collection = {
      findOneAndUpdate: jest.fn().mockRejectedValue(collision),
    };
    await expect(
      ensureInvoiceCode(
        { collection } as never,
        { _id: new Types.ObjectId() } as never,
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(collection.findOneAndUpdate).toHaveBeenCalledTimes(5);
  });
  it('whitelists the entire filename and rejects injection', () => {
    expect(invoiceFilename('INV-20260910-K7P4X2M9')).toBe(
      'SmartOrder-INV-20260910-K7P4X2M9.pdf',
    );
    expect(() => invoiceFilename('../bad\r\nfile')).toThrow();
  });
});
