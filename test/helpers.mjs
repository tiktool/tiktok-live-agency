// Scripted fetch: each call shifts the next response off the queue and records the request.
export function mockFetch(responses) {
  const queue = [...responses];
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: new URL(url), method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected request ${init.method} ${url}`);
    if (next instanceof Error) throw next;
    const { status = 200, body = {}, headers = {} } = typeof next === 'function' ? next(new URL(url), init) : next;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  };
  fn.calls = calls;
  fn.remaining = () => queue.length;
  return fn;
}

export const quiet = () => {};
