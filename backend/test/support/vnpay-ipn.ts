import { createHmac } from 'node:crypto';

/** Provider-shaped callback signed independently of VnpayService's private code. */
export function signedIpnFixture(
  intent: { txnRef: string; amount: number },
  config: { merchantCode: string; hashSecret: string },
  outcome: 'success' | 'cancelled' = 'success',
): Record<string, string> {
  const params: Record<string, string> = {
    vnp_TmnCode: config.merchantCode,
    vnp_TxnRef: intent.txnRef,
    vnp_Amount: String(intent.amount * 100),
    vnp_ResponseCode: outcome === 'success' ? '00' : '24',
    vnp_TransactionStatus: outcome === 'success' ? '00' : '02',
    vnp_TransactionNo: '123456789',
  };
  const data = Object.keys(params)
    .sort()
    .map(
      (key) => `${key}=${encodeURIComponent(params[key]).replace(/%20/g, '+')}`,
    )
    .join('&');
  return {
    ...params,
    vnp_SecureHash: createHmac('sha512', config.hashSecret)
      .update(data, 'utf8')
      .digest('hex'),
  };
}
