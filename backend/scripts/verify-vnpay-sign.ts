import { createHmac } from 'crypto';

const signData = process.env.VNP_SIGN_DATA;
const secret = process.env.VNP_HASH_SECRET;
if (!signData || !secret) {
  throw new Error('Set VNP_SIGN_DATA and VNP_HASH_SECRET before running this script.');
}

// Deliberately standalone: it does not import the VNPAY service or its helpers.
console.log(createHmac('sha512', secret).update(signData, 'utf8').digest('hex'));
