export const handlers = {
  probeWaiting: async (ctx) => {
    await ctx.callOpenApi('AliyunDeliveryService', 'ListModelSeries', {});
  },
  probeCall: async (ctx, _opts, positional) => {
    const request = JSON.parse(positional[0]);
    const context = { hasFn: typeof ctx.callOpenApi === 'function', keys: Object.keys(ctx).sort() };
    try {
      const result = await ctx.callOpenApi(request.product, request.action, request.params);
      process.stdout.write(JSON.stringify({ ...context, result }));
    } catch (error) {
      process.stdout.write(
        JSON.stringify({
          ...context,
          error: { code: error.code, exitCode: error.exitCode, message: error.message },
        }),
      );
    }
  },
  probeAnonymousSearch: async (ctx) => {
    await ctx.callOpenApi('WebsitePortal', 'SearchHub', { Query: 'demo' });
  },
  probeRawSearch: async (ctx) => {
    const result = await ctx.callOpenApi('WebsitePortal', 'SearchHub', { Query: 'demo' });
    process.stdout.write(JSON.stringify(result));
  },
};
