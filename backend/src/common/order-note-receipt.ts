import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import type { OrderNoteAnalysis } from './schemas/order-note-analysis.schema';

// Ephemeral process key: restart/another instance invalidates pending previews,
// safely dropping only optional metadata. No provider/config/DB dependency in cart.
const key = randomBytes(32);
const digest = (note: string) =>
  createHash('sha256').update(note.trim()).digest('hex');
const sign = (value: string) =>
  createHmac('sha256', key).update(value).digest();
export function issueOrderNoteReceipt(
  sessionId: string,
  dishId: string,
  note: string,
  analysis: OrderNoteAnalysis,
): string {
  const body = Buffer.from(
    JSON.stringify({
      sessionId,
      dishId,
      noteHash: digest(note),
      expiresAt: Date.now() + 30 * 60_000,
      analysis,
    }),
  ).toString('base64url');
  return `${body}.${sign(body).toString('base64url')}`;
}

/** Invalid/expired/unconfirmed metadata never prevents an ordinary cart mutation. */
export function readOrderNoteReceipt(
  token: unknown,
  sessionId: string,
  dishId: string,
  note: string,
  modifiers: readonly string[],
): OrderNoteAnalysis | undefined {
  if (typeof token !== 'string' || token.length > 12000) return;
  try {
    const parts = token.split('.');
    if (parts.length !== 2) return;
    const [body, signature] = parts;
    const actual = Buffer.from(signature, 'base64url');
    const expected = sign(body);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return;
    const data = JSON.parse(Buffer.from(body, 'base64url').toString()) as {
      sessionId: string;
      dishId: string;
      noteHash: string;
      expiresAt: number;
      analysis: OrderNoteAnalysis;
    };
    if (
      data.sessionId !== sessionId ||
      data.dishId !== dishId ||
      data.noteHash !== digest(note) ||
      data.expiresAt <= Date.now()
    )
      return;
    if (
      !data.analysis.confirmedByCustomer ||
      data.analysis.modifierTags.some((tag) => !modifiers.includes(tag))
    )
      return;
    return data.analysis;
  } catch {
    return;
  }
}
