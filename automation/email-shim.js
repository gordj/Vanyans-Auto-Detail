// Stand-in for Cloudflare's "cloudflare:email" module so the worker can run in a browser test.
export class EmailMessage {
  constructor(from, to, raw) {
    this.from = from;
    this.to = to;
    this.raw = raw;
  }
}
