# Billing

Payments sit behind `BillingProvider` (`lib/billing/`). `BILLING_PROVIDER` picks the implementation:

| Value | Use |
| --- | --- |
| `mock` | Default outside production. Checkout is a signed local link; no network. Used by tests and e2e. |
| `stripe` | Real payments through Stripe's REST API (`lib/billing/stripe.ts`, plain `fetch`, no SDK). |
| unset in production | Billing routes answer 503 and nobody can buy a plan. |

Subscription state changes only through `POST /api/billing/webhook`. The checkout, portal and cancel routes start something at the provider; the result arrives as a webhook.

## Set up Stripe in test mode

Do this with the platform owner's Stripe account, in **test mode** first (the toggle in the Stripe dashboard). Keys go in `.env.local` only; never commit or paste them.

1. **Prices.** In Products, create two products, Pro and Team. Give each a recurring monthly and a recurring yearly price, in the currency from `PLAN_PRICES` in `lib/plans.ts`. Copy the four price ids (`price_...`).
2. **API key.** Developers, API keys: copy the secret key (`sk_test_...`).
3. **Customer portal.** Settings, Billing, Customer portal: turn it on. Allow customers to cancel at the end of the period and to update their payment method. Without this, `POST /api/billing/portal` fails with a Stripe error.
4. **Webhook endpoint.** Developers, Webhooks, add an endpoint at `https://<your host>/api/billing/webhook` listening to `customer.subscription.created`, `customer.subscription.updated` and `customer.subscription.deleted`. Copy its signing secret (`whsec_...`). Other event types are acknowledged and ignored.
5. **Environment.**

```
BILLING_PROVIDER=stripe
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_PRO_MONTH=price_...
STRIPE_PRICE_PRO_YEAR=price_...
STRIPE_PRICE_TEAM_MONTH=price_...
STRIPE_PRICE_TEAM_YEAR=price_...
```

A missing variable fails only the call that needs it, with a 503.

To try it on a laptop, forward events with the Stripe CLI (`stripe listen --forward-to localhost:3111/api/billing/webhook`) and use the `whsec_...` it prints as `STRIPE_WEBHOOK_SECRET`. Pay with the test card `4242 4242 4242 4242`.

Going live repeats steps 1 to 5 with live-mode objects and keys.

## How Stripe events become plans

- Checkout puts the workspace id in the subscription's metadata. A subscription without it, or with a price that is not one of the four above, is ignored.
- The plan and interval come from the price id. The period end comes from the subscription item (or the subscription, on older API versions).
- `active` and `trialing` map as they are; `past_due` starts the grace period in `lib/plans.ts`; `canceled`, `unpaid` and `paused` map to `canceled`. `incomplete` states are ignored: payment never went through.
- Canceling in Stripe (`cancel_at_period_end`) keeps Stripe's status `active` until the end. We store it as `canceled` with the period end, so the plan page can show when access stops.
- Signatures: the `Stripe-Signature` header is checked with HMAC-SHA256 over `<timestamp>.<raw body>` and a five minute tolerance. Failures answer 400.
- Each event id is stored once in `billing_events`, so Stripe's retries do nothing.

## Not handled yet

- Events that arrive out of order overwrite each other in arrival order.
- Checkout always opens a new subscription. Changing plan on an existing subscription should go through the portal.
