# When to Mock

Fake the **environment** at system boundaries; keep every module we own real.

| Boundary | Use |
| --- | --- |
| Outbound HTTP (our services, third-party APIs, OTLP, LLM providers) | `msw` (`setupServer` from `msw/node`) |
| Postgres | Real test database — `*.integration.test.ts` gated on `DATABASE_URL` (see root AGENTS.md → Testing) |
| Config | `vi.stubEnv`, or pass the value as an argument |
| Time / randomness | `vi.useFakeTimers()`; inject the random source |
| Telemetry output | OTel SDK in-memory exporters |

`vi.mock` of a repo module is reserved for an import-time side effect that cannot be configured, with a one-line comment naming it. Mocking our own env, db client, logger, or retry helper tests the mock: the test keeps passing when behavior breaks and fails when a refactor keeps it.

## Designing for Mockability

These patterns shape the boundary adapters msw or the test database exercises; they are not a licence to inject fakes of our own modules.

At system boundaries, design interfaces that are easy to mock:

**1. Use dependency injection**

Pass external dependencies in rather than creating them internally:

```typescript
// Easy to mock
function processPayment(order, paymentClient) {
  return paymentClient.charge(order.total);
}

// Hard to mock
function processPayment(order) {
  const client = new StripeClient(process.env.STRIPE_KEY);
  return client.charge(order.total);
}
```

**2. Prefer SDK-style interfaces over generic fetchers**

Create specific functions for each external operation instead of one generic function with conditional logic:

```typescript
// GOOD: Each function is independently mockable
const api = {
  getUser: (id) => fetch(`/users/${id}`),
  getOrders: (userId) => fetch(`/users/${userId}/orders`),
  createOrder: (data) => fetch('/orders', { method: 'POST', body: data }),
};

// BAD: Mocking requires conditional logic inside the mock
const api = {
  fetch: (endpoint, options) => fetch(endpoint, options),
};
```

The SDK approach means:
- Each mock returns one specific shape
- No conditional logic in test setup
- Easier to see which endpoints a test exercises
- Type safety per endpoint
