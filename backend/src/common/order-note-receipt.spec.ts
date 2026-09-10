import {
  issueOrderNoteReceipt,
  readOrderNoteReceipt,
} from './order-note-receipt';
import type { OrderNoteAnalysis } from './schemas/order-note-analysis.schema';

describe('Order note receipt authenticity and fail-open', () => {
  const analysis: OrderNoteAnalysis = {
    summary: 'Không hành',
    modifierTags: ['NO_ONION'],
    allergyMentioned: false,
    warnings: [],
    modelVersion: 'test:order-note-v1',
    fallbackUsed: false,
    confirmedByCustomer: true,
  };
  const create = () =>
    issueOrderNoteReceipt('session', 'dish', ' không hành ', analysis);
  const read = (token: unknown) =>
    readOrderNoteReceipt(token, 'session', 'dish', 'không hành', ['NO_ONION']);
  it('roundtrips exact server metadata, matches trimmed original identity', () => {
    expect(read(create())).toEqual(analysis);
  });
  it.each([undefined, null, {}, '', 'a.b.c', 'a.b', 'x'.repeat(12001)])(
    'ignores malformed metadata %#',
    (token) => {
      expect(read(token)).toBeUndefined();
    },
  );
  it('rejects modified body and signature', () => {
    const token = create();
    const [body, signature] = token.split('.');
    expect(read(`${body}x.${signature}`)).toBeUndefined();
    expect(
      read(`${body}.${Buffer.alloc(32).toString('base64url')}`),
    ).toBeUndefined();
  });
  it.each([
    ['other', 'dish', 'không hành'],
    ['session', 'other', 'không hành'],
    ['session', 'dish', 'ít cay'],
  ])('rejects replay against %s/%s/%s', (session, dish, note) => {
    expect(
      readOrderNoteReceipt(create(), session, dish, note, ['NO_ONION']),
    ).toBeUndefined();
  });
  it('drops stale previews when dish removes the modifier', () => {
    expect(
      readOrderNoteReceipt(create(), 'session', 'dish', 'không hành', []),
    ).toBeUndefined();
  });
  it('expires after 30 minutes, without throwing', () => {
    const token = create();
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + 31 * 60000);
    try {
      expect(read(token)).toBeUndefined();
    } finally {
      jest.restoreAllMocks();
    }
  });
});
