// POST /api/verify-payment
// Body: { orderID, name, email, service, message }
//
// This never trusts the browser's "payment succeeded" message on its own.
// It re-checks the order directly with PayPal using server-side credentials,
// confirms it was actually paid, paid at least $1 USD, and paid to the
// right merchant account — only then does it send the inquiry email.
//
// Required environment variables (set in Cloudflare Pages → Settings → Environment variables):
//   PAYPAL_CLIENT_ID      — from your PayPal REST app (developer.paypal.com)
//   PAYPAL_CLIENT_SECRET  — from the same REST app (mark as "encrypted")
//   PAYPAL_MERCHANT_ID    — CZCL9UWLMML8Q
//   RESEND_API_KEY        — from resend.com (mark as "encrypted")
//   NOTIFY_FROM           — a sender address on a domain you've verified in Resend,
//                           e.g. "ARKITECH Console <console@evlgam3.com>"
// Optional:
//   INQUIRIES             — a KV namespace binding, used to skip re-processing
//                           the same PayPal order twice (idempotency).

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return json({ ok: false, error: 'Malformed request.' }, 400);
  }

  const orderID = (body.orderID || '').toString().trim();
  const name = (body.name || '').toString().trim().slice(0, 200);
  const email = (body.email || '').toString().trim().slice(0, 200);
  const service = (body.service || 'General Inquiry').toString().trim().slice(0, 100);
  const message = (body.message || '').toString().trim().slice(0, 4000);

  if (!orderID || !name || !email || !message) {
    return json({ ok: false, error: 'Missing required fields.' }, 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ ok: false, error: 'Invalid email address.' }, 400);
  }

  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET || !env.PAYPAL_MERCHANT_ID) {
    return json({ ok: false, error: 'Server is not configured for payments yet.' }, 500);
  }

  // Idempotency: don't act twice on the same PayPal order.
  const seenKey = `order:${orderID}`;
  if (env.INQUIRIES) {
    const already = await env.INQUIRIES.get(seenKey);
    if (already) return json({ ok: true, note: 'already processed' }, 200);
  }

  // 1. Get a short-lived OAuth token using the server-side app credentials.
  const basicAuth = btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`);
  const tokenRes = await fetch('https://api-m.paypal.com/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  if (!tokenRes.ok) {
    return json({ ok: false, error: 'Could not authenticate with PayPal.' }, 502);
  }
  const tokenData = await tokenRes.json();

  // 2. Ask PayPal directly what this order actually did — never trust the client for this.
  const orderRes = await fetch(
    `https://api-m.paypal.com/v2/checkout/orders/${encodeURIComponent(orderID)}`,
    { headers: { 'Authorization': `Bearer ${tokenData.access_token}` } }
  );
  if (!orderRes.ok) {
    return json({ ok: false, error: 'Could not verify this order with PayPal.' }, 502);
  }
  const order = await orderRes.json();

  const unit = (order.purchase_units || [])[0] || {};
  const amount = unit.amount || {};
  const payeeMerchantId = (unit.payee || {}).merchant_id;

  const statusOk = order.status === 'COMPLETED';
  const amountOk = parseFloat(amount.value || '0') >= 1 && amount.currency_code === 'USD';
  const merchantOk = payeeMerchantId === env.PAYPAL_MERCHANT_ID;

  if (!statusOk || !amountOk || !merchantOk) {
    return json({ ok: false, error: 'Payment could not be verified as complete.' }, 402);
  }

  if (env.INQUIRIES) {
    await env.INQUIRIES.put(seenKey, '1', { expirationTtl: 60 * 60 * 24 * 30 });
  }

  // 3. Only now — after a verified $1 payment to the right account — send the email.
  const payer = order.payment_source && order.payment_source.paypal;
  const payerEmail = payer && payer.email_address;

  const emailRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: env.NOTIFY_FROM,
      to: 'evl.arkitech@gmail.com',
      reply_to: email,
      subject: `[PAID $1] New contract inquiry — ${service}`,
      text:
`Connection fee verified — PayPal order ${orderID}, $${amount.value} ${amount.currency_code}.
Payer PayPal email: ${payerEmail || 'n/a'}

From: ${name} <${email}>
Service: ${service}

Message:
${message}`
    })
  });

  if (!emailRes.ok) {
    return json({ ok: false, error: 'Payment verified, but the notification email failed to send.' }, 502);
  }

  return json({ ok: true }, 200);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
