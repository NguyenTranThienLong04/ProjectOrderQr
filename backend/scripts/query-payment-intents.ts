/** Read-only VNPAY reconciliation CLI. Never imported by application startup. */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { setServers } from 'node:dns';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'dotenv';
import { mongo } from 'mongoose';
import { assertDeploymentTarget } from './migrate-payment-intents';
import { UNRESOLVED_PAYMENT_FILTER } from '../src/modules/vnpay/payment-intent.schema';

// VNPAY QueryDr v2.1.0 uses pipe-delimited HMAC-SHA512, unlike pay/IPN's query string.
// https://sandbox.vnpayment.vn/apis/docs/truy-van-hoan-tien/querydr&refund.html
const RESPONSE_FIELDS = [
  'vnp_ResponseId',
  'vnp_Command',
  'vnp_ResponseCode',
  'vnp_Message',
  'vnp_TmnCode',
  'vnp_TxnRef',
  'vnp_Amount',
  'vnp_BankCode',
  'vnp_PayDate',
  'vnp_TransactionNo',
  'vnp_TransactionType',
  'vnp_TransactionStatus',
  'vnp_OrderInfo',
  'vnp_PromotionCode',
  'vnp_PromotionAmount',
];
export type QueryTarget = {
  txnRef: string;
  amount: number;
  transactionDate: string;
};
type Config = { tmnCode: string; hashSecret: string; ipAddress: string };
type Fields = Record<string, string>;
export type Assessment = {
  category: 'A_SUCCESS' | 'B_FAILED' | 'C_UNKNOWN' | 'D_ERROR';
  signatureValid: boolean;
  reason: string;
  responseCode?: string;
  transactionStatus?: string;
};

export function queryRequest(
  target: QueryTarget,
  config: Config,
  now = new Date(),
): Fields {
  if (
    !config.tmnCode ||
    !config.hashSecret ||
    !isIP(config.ipAddress) ||
    !/^[a-zA-Z0-9]{1,100}$/.test(target.txnRef) ||
    !/^\d{14}$/.test(target.transactionDate)
  )
    throw new Error(
      'Invalid QueryDr configuration or original transaction date',
    );
  const request: Fields = {
    vnp_RequestId: randomUUID().replaceAll('-', ''),
    vnp_Version: '2.1.0',
    vnp_Command: 'querydr',
    vnp_TmnCode: config.tmnCode,
    vnp_TxnRef: target.txnRef,
    vnp_TransactionDate: target.transactionDate,
    vnp_CreateDate: new Date(now.getTime() + 7 * 3600000)
      .toISOString()
      .replace(/[-:T]/g, '')
      .slice(0, 14),
    vnp_IpAddr: config.ipAddress,
    vnp_OrderInfo: `Reconcile ${target.txnRef}`,
  };
  request.vnp_SecureHash = createHmac('sha512', config.hashSecret)
    .update(Object.values(request).join('|'))
    .digest('hex');
  return request;
}

export function assessQueryResponse(
  raw: unknown,
  target: QueryTarget,
  config: Pick<Config, 'tmnCode' | 'hashSecret'>,
): Assessment {
  const unknown = (reason: string, signatureValid = false): Assessment => ({
    category: 'C_UNKNOWN',
    signatureValid,
    reason,
  });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return unknown('invalid-response');
  const fields: Fields = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value == null) fields[key] = '';
    else if (typeof value === 'string') fields[key] = value;
    else if (typeof value === 'number' && Number.isSafeInteger(value))
      fields[key] = String(value);
    else return unknown('invalid-field-type');
  }
  const details = {
    responseCode: /^\d{2}$/.test(fields.vnp_ResponseCode ?? '')
      ? fields.vnp_ResponseCode
      : undefined,
    transactionStatus: /^\d{2}$/.test(fields.vnp_TransactionStatus ?? '')
      ? fields.vnp_TransactionStatus
      : undefined,
  };
  if (!/^[a-fA-F0-9]{128}$/.test(fields.vnp_SecureHash ?? ''))
    return { ...unknown('missing-or-invalid-signature'), ...details };
  const data = RESPONSE_FIELDS.map((key) => fields[key] ?? '').join('|');
  const expected = createHmac('sha512', config.hashSecret)
    .update(data)
    .digest();
  if (!timingSafeEqual(expected, Buffer.from(fields.vnp_SecureHash, 'hex')))
    return { ...unknown('signature-mismatch'), ...details };
  const result = { signatureValid: true, ...details };
  if (
    (fields.vnp_Command && fields.vnp_Command !== 'querydr') ||
    fields.vnp_TmnCode !== config.tmnCode ||
    fields.vnp_TxnRef !== target.txnRef
  )
    return { ...unknown('response-identity-mismatch', true), ...details };
  if (fields.vnp_ResponseCode === '91')
    return {
      ...result,
      category: 'C_UNKNOWN',
      reason: 'transaction-not-found',
    };
  // QueryDr response code is the query outcome, NOT the payment response code.
  if (fields.vnp_ResponseCode !== '00')
    return { ...result, category: 'D_ERROR', reason: 'provider-query-error' };
  if (
    !Number.isSafeInteger(target.amount * 100) ||
    !/^\d+$/.test(fields.vnp_Amount ?? '') ||
    Number(fields.vnp_Amount) !== target.amount * 100 ||
    fields.vnp_TransactionType !== '01' ||
    !/^\d+$/.test(fields.vnp_TransactionNo ?? '')
  )
    return {
      ...unknown('payment-identity-or-amount-mismatch', true),
      ...details,
    };
  if (
    fields.vnp_TransactionStatus === '00' &&
    !/^0+$/.test(fields.vnp_TransactionNo)
  )
    return {
      ...result,
      category: 'A_SUCCESS',
      reason: 'verified-payment-success',
    };
  if (fields.vnp_TransactionStatus === '02')
    return {
      ...result,
      category: 'B_FAILED',
      reason: 'verified-payment-failure',
    };
  return {
    ...result,
    category: 'C_UNKNOWN',
    reason: 'nonterminal-or-unsupported-payment-state',
  };
}

export async function queryProvider(
  target: QueryTarget,
  config: Config,
  endpoint: string,
  fetcher = fetch,
) {
  const request = queryRequest(target, config);
  try {
    const response = await fetcher(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(25000),
    });
    if (!response.ok)
      return {
        assessment: {
          category: 'D_ERROR',
          signatureValid: false,
          reason: `http-${response.status}`,
        } as Assessment,
      };
    const raw: unknown = await response.json();
    return {
      response: raw,
      assessment: assessQueryResponse(raw, target, config),
    };
  } catch {
    return {
      assessment: {
        category: 'D_ERROR',
        signatureValid: false,
        reason: 'network-timeout-or-invalid-json',
      } as Assessment,
    };
  }
}

type SelectedIntent = mongo.Document & {
  _id: mongo.ObjectId;
  txnRef: string;
  amount: number;
  sessionId: mongo.ObjectId;
  status: string;
  transactionDate: { captures: string[] } | null;
  terminal: { captures: string[] } | null;
};

async function main() {
  const { values } = parseArgs({
    options: {
      'env-file': { type: 'string' },
      'expected-host': { type: 'string' },
      'expected-db': { type: 'string' },
      deployment: { type: 'string' },
      'session-id': { type: 'string' },
      'ip-address': { type: 'string' },
    },
  });
  const env = values['env-file']
    ? parse(await readFile(values['env-file']))
    : process.env;
  assertDeploymentTarget(
    env.MONGODB_URI ?? '',
    values['expected-host'] ?? '',
    values['expected-db'] ?? '',
    values.deployment ?? '',
  );
  if (
    !/^[a-fA-F0-9]{24}$/.test(values['session-id'] ?? '') ||
    !isIP(values['ip-address'] ?? '')
  )
    throw new Error(
      'Supply --session-id and the querying machine --ip-address',
    );
  const provider = new URL(env.VNP_URL ?? '');
  if (
    provider.protocol !== 'https:' ||
    provider.hostname !== 'sandbox.vnpayment.vn' ||
    provider.username ||
    provider.password
  )
    throw new Error(
      'This incident reconciliation only supports the confirmed VNPAY sandbox deployment',
    );
  const config = {
    tmnCode: env.VNP_TMN_CODE ?? '',
    hashSecret: env.VNP_HASH_SECRET ?? '',
    ipAddress: values['ip-address']!,
  };
  if (env.CUSTOM_DNS_SERVERS) setServers(env.CUSTOM_DNS_SERVERS.split(','));
  const client = new mongo.MongoClient(env.MONGODB_URI!, {
    serverSelectionTimeoutMS: 15000,
  });
  try {
    await client.connect();
    const intents = await client
      .db(values['expected-db'])
      .collection('payment_intents')
      .aggregate<SelectedIntent>([
        {
          $match: {
            sessionId: new mongo.ObjectId(values['session-id']),
            ...UNRESOLVED_PAYMENT_FILTER,
          },
        },
        {
          $project: {
            _id: 1,
            txnRef: 1,
            amount: 1,
            createdAt: 1,
            expiresAt: 1,
            status: 1,
            ipnConfirmed: 1,
            coveredOrderIds: 1,
            sessionId: 1,
            // Return only required original query fields, never the full payment URL/signature.
            transactionDate: {
              $regexFind: {
                input: '$paymentUrl',
                regex: '[?&]vnp_CreateDate=([0-9]{14})(?:&|$)',
              },
            },
            terminal: {
              $regexFind: {
                input: '$paymentUrl',
                regex: '[?&]vnp_TmnCode=([^&]+)',
              },
            },
          },
        },
        { $sort: { _id: 1 } },
      ])
      .toArray();
    if (intents.length !== 2)
      throw new Error(
        'Expected exactly two unresolved intents; stop and review changed data',
      );
    const results: unknown[] = [];
    for (const { terminal, transactionDate, ...intent } of intents) {
      if (
        decodeURIComponent(terminal?.captures[0] ?? '') !== config.tmnCode ||
        !transactionDate
      )
        throw new Error(
          'Original transaction date/merchant unavailable or mismatched; no query sent',
        );
      const target = {
        txnRef: intent.txnRef,
        amount: intent.amount,
        transactionDate: transactionDate.captures[0],
      };
      const result = await queryProvider(
        target,
        config,
        'https://sandbox.vnpayment.vn/merchant_webapi/api/transaction',
      );
      results.push({
        intent,
        transactionDate: target.transactionDate,
        ...result,
      });
      console.log(
        JSON.stringify({
          txnRef: intent.txnRef,
          localStatus: intent.status,
          transactionDate: target.transactionDate,
          ...result.assessment,
          action:
            result.assessment.category === 'B_FAILED'
              ? 'eligible-for-migration-review'
              : 'preserve-and-reconcile',
        }),
      );
    }
    const directory = resolve(__dirname, '../tmp');
    await mkdir(directory, { recursive: true });
    const reportPath = resolve(
      directory,
      `payment-intent-querydr-report-${randomUUID()}.json`,
    );
    await writeFile(
      reportPath,
      mongo.BSON.EJSON.stringify(
        { queriedAt: new Date(), results },
        { relaxed: false },
      ),
      { flag: 'wx', mode: 0o600 },
    );
    console.log(JSON.stringify({ reportPath, databaseWrites: 0 }));
  } finally {
    await client.close();
  }
}

if (require.main === module)
  void main().catch(() => {
    console.error(
      'Reconciliation stopped: invalid target/configuration or database unavailable; sensitive details redacted.',
    );
    process.exitCode = 1;
  });
