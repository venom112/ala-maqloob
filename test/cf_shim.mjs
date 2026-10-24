// Stand-in for Cloudflare's "cloudflare:workers" module, for the tests.
export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
