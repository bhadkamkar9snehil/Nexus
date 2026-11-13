// Collect only provider counters, including decisions that never produce a browser action.
const fetchOriginal = globalThis.fetch;
const provider = new URL(process.env.TYPESAFE_BASE_URL || 'https://api.typesafe.ai');
globalThis.fetch = async (input, options) => {
  const response = await fetchOriginal(input, options);
  const url = new URL(input instanceof Request ? input.url : input);
  if (response.ok && url.origin === provider.origin && url.pathname.endsWith('/v1/systemone')) {
    try {
      const { usage } = await response.clone().json();
      process.send?.({ usage: { input_tokens: usage?.input_tokens, output_tokens: usage?.output_tokens } });
    } catch { /* A missing counter must not affect browser execution. */ }
  }
  return response;
};
